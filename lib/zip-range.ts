import { inflateSync } from "fflate";
import {
  buildListingWithFolders,
  formatArchiveSize,
  getArchiveEntryType,
  type ArchiveListingEntry,
} from "@/lib/archive-listing";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CDFH_SIGNATURE = 0x02014b50;
const LFH_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const TAIL_SEARCH_BYTES = 256 * 1024;

export type ZipEntryMeta = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  compressionMethod: number;
  isDir: boolean;
};

export interface ZipByteReader {
  getSize(): Promise<number>;
  read(start: number, endInclusive: number): Promise<Uint8Array>;
  supportsRangeRequests?: boolean;
}

export class NetworkInterruptedError extends Error {
  constructor(cause?: unknown) {
    super("Network interrupted, please retry.");
    this.name = "NetworkInterruptedError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class ZipRangeNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipRangeNotSupportedError";
  }
}

function readUint16LE(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUint32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function readUint64LE(view: DataView, offset: number): number {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  const value = high * 2 ** 32 + low;
  if (!Number.isSafeInteger(value)) {
    throw new Error("Archive entry exceeds JavaScript safe integer size.");
  }
  return value;
}

function findSignatureInTail(
  tail: Uint8Array,
  signature: number,
  minLength: number
): number {
  for (let i = tail.length - minLength; i >= 0; i--) {
    const view = new DataView(tail.buffer, tail.byteOffset + i, 4);
    if (view.getUint32(0, true) === signature) {
      return i;
    }
  }
  return -1;
}

function parseZip64Extra(
  extra: Uint8Array,
  needsUncompressed: boolean,
  needsCompressed: boolean,
  needsOffset: boolean
): { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } {
  let offset = 0;
  const result: {
    uncompressedSize?: number;
    compressedSize?: number;
    localHeaderOffset?: number;
  } = {};

  while (offset + 4 <= extra.length) {
    const view = new DataView(extra.buffer, extra.byteOffset + offset);
    const headerId = readUint16LE(view, 0);
    const dataSize = readUint16LE(view, 2);
    offset += 4;
    const data = extra.subarray(offset, offset + dataSize);
    offset += dataSize;

    if (headerId !== ZIP64_EXTRA_ID) continue;

    let dataOffset = 0;
    const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (needsUncompressed) {
      result.uncompressedSize = readUint64LE(dataView, dataOffset);
      dataOffset += 8;
    }
    if (needsCompressed) {
      result.compressedSize = readUint64LE(dataView, dataOffset);
      dataOffset += 8;
    }
    if (needsOffset) {
      result.localHeaderOffset = readUint64LE(dataView, dataOffset);
    }
    break;
  }

  return result;
}

async function locateCentralDirectory(
  reader: ZipByteReader
): Promise<{ offset: number; size: number }> {
  const fileSize = await reader.getSize();
  if (fileSize < 22) {
    throw new Error("Invalid or corrupt ZIP archive.");
  }

  const tailSize = Math.min(TAIL_SEARCH_BYTES, fileSize);
  const tailStart = fileSize - tailSize;
  const tail = await reader.read(tailStart, fileSize - 1);
  const eocdIndex = findSignatureInTail(tail, EOCD_SIGNATURE, 22);
  if (eocdIndex === -1) {
    throw new Error("Could not locate ZIP central directory.");
  }

  const eocdOffset = tailStart + eocdIndex;
  const eocd = await reader.read(eocdOffset, fileSize - 1);
  const eocdView = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);

  let centralDirectorySize = readUint32LE(eocdView, 12);
  let centralDirectoryOffset = readUint32LE(eocdView, 16);

  if (
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    const locatorIndex = findSignatureInTail(
      tail,
      ZIP64_EOCD_LOCATOR_SIGNATURE,
      20
    );
    if (locatorIndex === -1) {
      throw new Error("ZIP64 archive is missing required metadata.");
    }

    const locatorOffset = tailStart + locatorIndex;
    const locator = await reader.read(locatorOffset, locatorOffset + 19);
    const locatorView = new DataView(
      locator.buffer,
      locator.byteOffset,
      locator.byteLength
    );
    const zip64EocdOffset = Number(readUint64LE(locatorView, 8));
    const zip64Eocd = await reader.read(zip64EocdOffset, zip64EocdOffset + 55);
    const zip64View = new DataView(
      zip64Eocd.buffer,
      zip64Eocd.byteOffset,
      zip64Eocd.byteLength
    );

    if (readUint32LE(zip64View, 0) !== ZIP64_EOCD_SIGNATURE) {
      throw new Error("Invalid ZIP64 end-of-central-directory record.");
    }

    centralDirectorySize = readUint64LE(zip64View, 40);
    centralDirectoryOffset = readUint64LE(zip64View, 48);
  }

  return { offset: centralDirectoryOffset, size: centralDirectorySize };
}

export async function listZipEntries(
  reader: ZipByteReader
): Promise<ZipEntryMeta[]> {
  const { offset, size } = await locateCentralDirectory(reader);
  const centralDirectory = await reader.read(offset, offset + size - 1);
  const entries: ZipEntryMeta[] = [];

  let cursor = 0;
  while (cursor + 46 <= centralDirectory.length) {
    const view = new DataView(
      centralDirectory.buffer,
      centralDirectory.byteOffset + cursor,
      centralDirectory.byteLength - cursor
    );

    if (readUint32LE(view, 0) !== CDFH_SIGNATURE) {
      break;
    }

    const compressionMethod = readUint16LE(view, 10);
    let compressedSize = readUint32LE(view, 20);
    let uncompressedSize = readUint32LE(view, 24);
    let localHeaderOffset = readUint32LE(view, 42);
    const fileNameLength = readUint16LE(view, 28);
    const extraFieldLength = readUint16LE(view, 30);
    const fileCommentLength = readUint16LE(view, 32);
    const headerSize = 46 + fileNameLength + extraFieldLength + fileCommentLength;

    if (cursor + headerSize > centralDirectory.length) {
      break;
    }

    const nameBytes = centralDirectory.subarray(
      cursor + 46,
      cursor + 46 + fileNameLength
    );
    const name = new TextDecoder().decode(nameBytes);
    const extraField = centralDirectory.subarray(
      cursor + 46 + fileNameLength,
      cursor + 46 + fileNameLength + extraFieldLength
    );

    const needsZip64 =
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff;

    if (needsZip64) {
      const zip64 = parseZip64Extra(
        extraField,
        uncompressedSize === 0xffffffff,
        compressedSize === 0xffffffff,
        localHeaderOffset === 0xffffffff
      );
      if (zip64.compressedSize !== undefined) compressedSize = zip64.compressedSize;
      if (zip64.uncompressedSize !== undefined) {
        uncompressedSize = zip64.uncompressedSize;
      }
      if (zip64.localHeaderOffset !== undefined) {
        localHeaderOffset = zip64.localHeaderOffset;
      }
    }

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      compressionMethod,
      isDir: name.endsWith("/"),
    });

    cursor += headerSize;
  }

  return entries;
}

export function zipEntriesToListing(entries: ZipEntryMeta[]): ArchiveListingEntry[] {
  return buildListingWithFolders(
    entries
      .filter((entry) => !entry.isDir)
      .map((entry) => ({
        path: entry.name,
        size: entry.uncompressedSize,
      }))
  );
}

async function getCompressedPayloadOffset(
  reader: ZipByteReader,
  entry: ZipEntryMeta
): Promise<{ dataOffset: number; compressedSize: number }> {
  const headerChunk = await reader.read(
    entry.localHeaderOffset,
    entry.localHeaderOffset + 4095
  );
  const view = new DataView(
    headerChunk.buffer,
    headerChunk.byteOffset,
    headerChunk.byteLength
  );

  if (readUint32LE(view, 0) !== LFH_SIGNATURE) {
    throw new Error(`Invalid local header for ${entry.name}.`);
  }

  const fileNameLength = readUint16LE(view, 26);
  const extraFieldLength = readUint16LE(view, 28);
  const dataOffset =
    entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;

  return { dataOffset, compressedSize: entry.compressedSize };
}

export async function extractZipEntry(
  reader: ZipByteReader,
  entry: ZipEntryMeta
): Promise<Uint8Array> {
  if (entry.isDir) {
    throw new Error("Cannot extract a directory entry.");
  }

  const { dataOffset, compressedSize } = await getCompressedPayloadOffset(
    reader,
    entry
  );
  const compressed = await reader.read(
    dataOffset,
    dataOffset + compressedSize - 1
  );

  if (entry.compressionMethod === 0) {
    return compressed;
  }

  if (entry.compressionMethod === 8) {
    return inflateSync(compressed);
  }

  throw new Error(
    `Unsupported compression method (${entry.compressionMethod}) for ${entry.name}.`
  );
}

async function safeFetch(input: RequestInfo | URL, init?: RequestInit) {
  try {
    return await fetch(input, init);
  } catch (error) {
    throw new NetworkInterruptedError(error);
  }
}

export async function fetchRemoteArchiveSize(url: string): Promise<number | null> {
  const response = await safeFetch(url, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`Failed to fetch archive metadata (HTTP ${response.status}).`);
  }

  const contentLength = response.headers.get("content-length");
  if (!contentLength) return null;

  const sizeBytes = Number(contentLength);
  return Number.isNaN(sizeBytes) ? null : sizeBytes;
}

export function createHttpZipReader(url: string): ZipByteReader {
  let cachedSize: number | null = null;

  return {
    supportsRangeRequests: true,
    async getSize() {
      if (cachedSize !== null) return cachedSize;
      cachedSize = await fetchRemoteArchiveSize(url);
      if (cachedSize === null) {
        throw new ZipRangeNotSupportedError(
          "Remote archive size is unknown. Range-based streaming requires a Content-Length header."
        );
      }
      return cachedSize;
    },
    async read(start, endInclusive) {
      if (start < 0 || endInclusive < start) {
        throw new Error("Invalid byte range request.");
      }

      const response = await safeFetch(url, {
        headers: {
          Range: `bytes=${start}-${endInclusive}`,
        },
      });

      if (response.status === 416) {
        throw new Error("Requested byte range is outside the archive size.");
      }

      if (!response.ok && response.status !== 206) {
        throw new Error(`Failed to fetch archive bytes (HTTP ${response.status}).`);
      }

      if (!response.body) {
        throw new NetworkInterruptedError();
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value.slice());
          loaded += value.byteLength;
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw new NetworkInterruptedError(error);
      }

      const expected = endInclusive - start + 1;
      if (loaded !== expected) {
        throw new NetworkInterruptedError();
      }

      const merged = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return merged;
    },
  };
}

export function createFileZipReader(file: File): ZipByteReader {
  return {
    supportsRangeRequests: false,
    async getSize() {
      return file.size;
    },
    async read(start, endInclusive) {
      const blob = file.slice(start, endInclusive + 1);
      const buffer = await blob.arrayBuffer();
      return new Uint8Array(buffer);
    },
  };
}

export function formatEntrySizeLabel(entry: ZipEntryMeta): string {
  return entry.isDir ? "—" : formatArchiveSize(entry.uncompressedSize);
}

export function entryToListingItem(entry: ZipEntryMeta): ArchiveListingEntry {
  return {
    name: entry.name,
    size: formatEntrySizeLabel(entry),
    isDir: entry.isDir,
    type: getArchiveEntryType(entry.name, entry.isDir),
  };
}
