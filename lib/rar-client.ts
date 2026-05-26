"use client";

import { Archive } from "libarchive.js";
import type { ArchiveReader } from "libarchive.js/dist/build/compiled/archive-reader";
import type { CompressedFile } from "libarchive.js/dist/build/compiled/compressed-file";

let libarchiveReady: Promise<void> | null = null;

export function ensureLibarchiveInit(): Promise<void> {
  if (!libarchiveReady) {
    libarchiveReady = Promise.resolve().then(() => {
      Archive.init({
        workerUrl: "/libarchive/worker-bundle.js",
      });
    });
  }
  return libarchiveReady;
}

export type RarFileEntry = {
  path: string;
  compressedFile: CompressedFile;
};

export async function openRarArchive(
  file: File
): Promise<{ reader: ArchiveReader; files: RarFileEntry[] }> {
  await ensureLibarchiveInit();
  const reader = await Archive.open(file);
  const listing = await reader.getFilesArray();
  const files: RarFileEntry[] = [];

  for (const item of listing) {
    const compressedFile = item.file as CompressedFile | string;
    if (
      !compressedFile ||
      typeof compressedFile === "string" ||
      typeof compressedFile.extract !== "function"
    ) {
      continue;
    }
    const fullPath = item.path
      ? `${item.path}${compressedFile.name}`
      : compressedFile.name;
    files.push({
      path: fullPath,
      compressedFile,
    });
  }

  return { reader, files };
}

export async function closeRarArchive(
  reader: ArchiveReader | null
): Promise<void> {
  if (!reader) return;
  try {
    await reader.close();
  } catch {
    // Reader may already be terminated after full extraction.
  }
}
