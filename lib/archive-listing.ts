export type ArchiveListingEntry = {
  name: string;
  size: string;
  isDir: boolean;
  type: string;
};

export function formatArchiveSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function getArchiveEntryType(name: string, isDir: boolean): string {
  if (isDir) return "folder";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext))
    return "image";
  if (["pdf", "txt"].includes(ext)) return "document";
  return "file";
}

export function buildListingWithFolders(
  files: { path: string; size: number }[]
): ArchiveListingEntry[] {
  const dirs = new Set<string>();

  for (const file of files) {
    const normalized = file.path.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 1) continue;

    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc += `${parts[i]}/`;
      dirs.add(acc);
    }
  }

  const entries: ArchiveListingEntry[] = [];

  for (const dir of Array.from(dirs).sort()) {
    entries.push({
      name: dir,
      size: "—",
      isDir: true,
      type: "folder",
    });
  }

  for (const file of files) {
    entries.push({
      name: file.path,
      size: formatArchiveSize(file.size),
      isDir: false,
      type: getArchiveEntryType(file.path, false),
    });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}
