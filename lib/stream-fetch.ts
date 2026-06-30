import { Unzip, UnzipInflate } from "fflate";
import { formatArchiveSize } from "@/lib/archive-listing";
import { NetworkInterruptedError } from "@/lib/zip-range";

/** Files above this size use Range-based streaming (no full download). */
export const STREAMING_MODE_THRESHOLD_BYTES = 1024 * 1024 * 1024;
export const STREAMING_MODE_THRESHOLD_LABEL = "1024.0 MB";

/** Hard upper limit for remote archives (10 GB). */
export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024 * 1024;
export const MAX_ARCHIVE_LABEL = "10.0 GB";

/** In-memory download cap for archives below streaming threshold. */
export const MAX_IN_MEMORY_ARCHIVE_BYTES = STREAMING_MODE_THRESHOLD_BYTES;

export class RemoteFileTooLargeError extends Error {
  readonly sizeBytes: number;

  constructor(sizeBytes: number) {
    const sizeLabel = formatArchiveSize(sizeBytes);
    super(
      `This file is ${sizeLabel}, which exceeds the ${MAX_ARCHIVE_LABEL} browser safety limit. Download a smaller archive or use a desktop extractor to avoid out-of-memory crashes.`
    );
    this.name = "RemoteFileTooLargeError";
    this.sizeBytes = sizeBytes;
  }
}

export type StreamFetchProgress = {
  loadedBytes: number;
  totalBytes: number | null;
};

type StreamFetchOptions = {
  maxBytes?: number;
  onProgress?: (progress: StreamFetchProgress) => void;
  validateZip?: boolean;
};

function assertWithinSizeLimit(sizeBytes: number, maxBytes: number): void {
  if (sizeBytes > maxBytes) {
    throw new RemoteFileTooLargeError(sizeBytes);
  }
}

function createZipStreamValidator(): {
  push: (chunk: Uint8Array) => void;
  finish: () => void;
} {
  const unzip = new Unzip();
  unzip.register(UnzipInflate);

  return {
    push(chunk) {
      try {
        unzip.push(chunk, false);
      } catch (err) {
        throw err instanceof Error
          ? err
          : new Error("Invalid or corrupt ZIP archive.");
      }
    },
    finish() {
      try {
        unzip.push(new Uint8Array(0), true);
      } catch (err) {
        throw err instanceof Error
          ? err
          : new Error("Invalid or corrupt ZIP archive.");
      }
    },
  };
}

export async function streamFetchToBlob(
  url: string,
  options: StreamFetchOptions = {}
): Promise<Blob> {
  const maxBytes = options.maxBytes ?? MAX_IN_MEMORY_ARCHIVE_BYTES;
  let response: Response;

  try {
    response = await fetch(url);
  } catch (error) {
    throw new NetworkInterruptedError(error);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch (HTTP ${response.status}).`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentLength =
    contentLengthHeader !== null ? Number(contentLengthHeader) : null;

  if (
    contentLength !== null &&
    !Number.isNaN(contentLength) &&
    contentLength > 0
  ) {
    assertWithinSizeLimit(contentLength, maxBytes);
  }

  const body = response.body;
  if (!body) {
    const blob = await response.blob();
    assertWithinSizeLimit(blob.size, maxBytes);
    options.onProgress?.({
      loadedBytes: blob.size,
      totalBytes: contentLength,
    });
    return blob;
  }

  const reader = body.getReader();
  const chunks: BlobPart[] = [];
  let loadedBytes = 0;
  const zipValidator = options.validateZip ? createZipStreamValidator() : null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      loadedBytes += value.byteLength;
      assertWithinSizeLimit(loadedBytes, maxBytes);

      const chunk = value.slice();
      chunks.push(chunk);
      zipValidator?.push(chunk);

      options.onProgress?.({
        loadedBytes,
        totalBytes: contentLength,
      });
    }

    zipValidator?.finish();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof NetworkInterruptedError) throw error;
    if (error instanceof RemoteFileTooLargeError) throw error;
    if (error instanceof Error) throw error;
    throw new NetworkInterruptedError(error);
  }

  return new Blob(chunks, {
    type: response.headers.get("content-type") ?? "application/octet-stream",
  });
}

export function assertArchiveWithinLimit(
  sizeBytes: number,
  maxBytes: number = MAX_ARCHIVE_BYTES
): void {
  assertWithinSizeLimit(sizeBytes, maxBytes);
}

export function assertLocalFileWithinLimit(
  file: File,
  maxBytes: number = MAX_IN_MEMORY_ARCHIVE_BYTES
): void {
  assertWithinSizeLimit(file.size, maxBytes);
}

export function shouldUseStreamingMode(sizeBytes: number | null): boolean {
  return (
    sizeBytes !== null &&
    !Number.isNaN(sizeBytes) &&
    sizeBytes > STREAMING_MODE_THRESHOLD_BYTES
  );
}

export { NetworkInterruptedError };
