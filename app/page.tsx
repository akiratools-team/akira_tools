"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import {
  Folder,
  FileText,
  Image as ImageIcon,
  File as FileIcon,
  Download,
  User,
  Archive,
} from "lucide-react";
import {
  buildListingWithFolders,
  formatArchiveSize,
  getArchiveEntryType,
  type ArchiveListingEntry,
} from "@/lib/archive-listing";
import { closeRarArchive, openRarArchive } from "@/lib/rar-client";
import type { ArchiveReader } from "libarchive.js/dist/build/compiled/archive-reader";
import type { CompressedFile } from "libarchive.js/dist/build/compiled/compressed-file";

type FileRoute = "zip" | "rar" | "image" | "video" | "pdf" | "unsupported";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const VIDEO_EXTENSIONS = [".mp4", ".webm"];

const INITIAL_HEADER_NAME = "important_marketing_docs_q4.zip";
const INITIAL_HEADER_SIZE = "1.8 GB";

function getFileExtension(source: string): string {
  const withoutQuery = source.split("?")[0] ?? source;
  const filename = withoutQuery.split("/").pop() ?? withoutQuery;
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) return "";
  return filename.slice(dotIndex).toLowerCase();
}

function getRouteFromExtension(ext: string): FileRoute {
  if (ext === ".zip") return "zip";
  if (ext === ".rar") return "rar";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  if (ext === ".pdf") return "pdf";
  return "unsupported";
}

function getDisplayName(source: string): string {
  const withoutQuery = source.split("?")[0] ?? source;
  return decodeURIComponent(withoutQuery.split("/").pop() ?? source);
}

function getDownloadName(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] || path;
}

function EntryIcon({ type }: { type: string }) {
  const className = "size-5 shrink-0";
  switch (type) {
    case "folder":
      return <Folder className={`${className} text-amber-600`} />;
    case "image":
      return <ImageIcon className={`${className} text-sky-500`} />;
    case "document":
      return <FileText className={`${className} text-red-500`} />;
    default:
      return <FileIcon className={`${className} text-gray-500`} />;
  }
}

function isArchiveRoute(route: FileRoute | null): route is "zip" | "rar" {
  return route === "zip" || route === "rar";
}

export default function ZipExtractorPage() {
  const [extractedFiles, setExtractedFiles] = useState<ArchiveListingEntry[]>(
    []
  );
  const [isExtracting, setIsExtracting] = useState(false);
  const [headerFileName, setHeaderFileName] = useState(INITIAL_HEADER_NAME);
  const [headerFileSize, setHeaderFileSize] = useState(INITIAL_HEADER_SIZE);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [zipInstance, setZipInstance] = useState<JSZip | null>(null);
  const [fileRoute, setFileRoute] = useState<FileRoute | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [currentFileUrl, setCurrentFileUrl] = useState<string | null>(null);
  const [fileExtension, setFileExtension] = useState("");
  const [originalUploadedFile, setOriginalUploadedFile] = useState<File | null>(
    null
  );

  const rarReaderRef = useRef<ArchiveReader | null>(null);
  const rarFileMapRef = useRef<Map<string, CompressedFile>>(new Map());
  const remoteArchiveUrlRef = useRef<string | null>(null);
  const hasLoadedUrlParam = useRef(false);

  const revokePreviewUrl = useCallback((url: string | null) => {
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
  }, []);

  const setPreview = useCallback(
    (nextUrl: string | null) => {
      setPreviewUrl((current) => {
        if (current && current !== nextUrl) revokePreviewUrl(current);
        return nextUrl;
      });
    },
    [revokePreviewUrl]
  );

  const clearRarArchive = useCallback(async () => {
    await closeRarArchive(rarReaderRef.current);
    rarReaderRef.current = null;
    rarFileMapRef.current = new Map();
  }, []);

  const resetArchiveState = useCallback(() => {
    setSelectedFiles(new Set());
    setExtractedFiles([]);
    setZipInstance(null);
    void clearRarArchive();
  }, [clearRarArchive]);

  const handleCancelPreview = useCallback(() => {
    setPreviewUrl((current) => {
      revokePreviewUrl(current);
      return null;
    });
    setCurrentFileUrl((current) => {
      if (current?.startsWith("blob:")) URL.revokeObjectURL(current);
      return null;
    });

    setExtractedFiles([]);
    setIsExtracting(false);
    setHeaderFileName(INITIAL_HEADER_NAME);
    setHeaderFileSize(INITIAL_HEADER_SIZE);
    setSelectedFiles(new Set());
    setZipInstance(null);
    setFileRoute(null);
    setFileExtension("");
    setOriginalUploadedFile(null);
    remoteArchiveUrlRef.current = null;
    void clearRarArchive();

    const url = new URL(window.location.href);
    url.searchParams.delete("fileurl");
    window.history.replaceState({}, "", url.pathname + url.search);
  }, [clearRarArchive, revokePreviewUrl]);

  const parseZipBlob = useCallback(async (blob: Blob) => {
    const zip = await JSZip.loadAsync(blob);
    setZipInstance(zip);

    const files: ArchiveListingEntry[] = [];
    for (const relativePath of Object.keys(zip.files)) {
      const zipEntry = zip.files[relativePath];
      const isDir = zipEntry.dir;
      const rawSize =
        (zipEntry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })
          ._data?.uncompressedSize ?? 0;

      files.push({
        name: relativePath,
        size: isDir ? "—" : formatArchiveSize(rawSize),
        isDir,
        type: getArchiveEntryType(relativePath, isDir),
      });
    }

    files.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    setExtractedFiles(files);
  }, []);

  const parseRarFile = useCallback(
    async (file: File) => {
      await clearRarArchive();
      const { reader, files } = await openRarArchive(file);
      rarReaderRef.current = reader;

      const fileMap = new Map<string, CompressedFile>();
      const listingInput: { path: string; size: number }[] = [];

      for (const entry of files) {
        fileMap.set(entry.path, entry.compressedFile);
        listingInput.push({
          path: entry.path,
          size: entry.compressedFile.size,
        });
      }

      rarFileMapRef.current = fileMap;
      setExtractedFiles(buildListingWithFolders(listingInput));
    },
    [clearRarArchive]
  );

  const loadArchiveBlob = useCallback(
    async (blob: Blob, displayName: string, route: "zip" | "rar") => {
      setHeaderFileSize(formatArchiveSize(blob.size));
      const archiveFile = new File(
        [blob],
        displayName,
        route === "rar"
          ? { type: "application/vnd.rar" }
          : { type: "application/zip" }
      );

      if (route === "zip") {
        await parseZipBlob(blob);
        return;
      }

      await parseRarFile(archiveFile);
    },
    [parseRarFile, parseZipBlob]
  );

  const loadFromSource = useCallback(
    async (source: string, file?: File) => {
      const extension = getFileExtension(source);
      const route = getRouteFromExtension(extension);
      const resolvedUrl = file ? URL.createObjectURL(file) : source;

      setFileExtension(extension);
      setFileRoute(route);
      setHeaderFileName(file?.name ?? getDisplayName(source));
      setCurrentFileUrl(resolvedUrl);
      resetArchiveState();

      if (route === "zip" || route === "rar") {
        if (file) {
          setOriginalUploadedFile(file);
          remoteArchiveUrlRef.current = null;
        } else {
          setOriginalUploadedFile(null);
          remoteArchiveUrlRef.current = source;
        }

        setIsExtracting(true);
        try {
          let blob: Blob;
          if (file) {
            blob = file;
          } else {
            const response = await fetch(source);
            if (!response.ok) throw new Error("Failed to fetch archive");
            blob = await response.blob();
          }
          setPreview(resolvedUrl);
          await loadArchiveBlob(
            blob,
            file?.name ?? getDisplayName(source),
            route
          );
        } catch {
          setExtractedFiles([]);
          setZipInstance(null);
          setOriginalUploadedFile(null);
          remoteArchiveUrlRef.current = null;
          await clearRarArchive();
          setFileRoute("unsupported");
          setPreview(null);
        } finally {
          setIsExtracting(false);
        }
        return;
      }

      setIsExtracting(false);
      setPreview(resolvedUrl);
      if (file) setHeaderFileSize(formatArchiveSize(file.size));
    },
    [clearRarArchive, loadArchiveBlob, resetArchiveState, setPreview]
  );

  useEffect(() => {
    if (hasLoadedUrlParam.current) return;
    const fileurl = new URLSearchParams(window.location.search).get("fileurl");
    if (!fileurl) return;
    hasLoadedUrlParam.current = true;
    loadFromSource(fileurl);
  }, [loadFromSource]);

  useEffect(() => {
    return () => {
      revokePreviewUrl(previewUrl);
      void clearRarArchive();
    };
  }, [clearRarArchive, previewUrl, revokePreviewUrl]);

  const toggleSelectedFile = (name: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDownload = async () => {
    if (selectedFiles.size === 0) return;

    if (fileRoute === "zip" && zipInstance) {
      for (const name of selectedFiles) {
        const zipEntry = zipInstance.file(name);
        if (!zipEntry || zipEntry.dir) continue;
        const blob = await zipEntry.async("blob");
        downloadBlob(blob, getDownloadName(name));
      }
      return;
    }

    if (fileRoute === "rar") {
      for (const name of selectedFiles) {
        const entry = extractedFiles.find((file) => file.name === name);
        if (entry?.isDir) continue;

        const compressedFile = rarFileMapRef.current.get(name);
        if (!compressedFile) continue;

        const extracted = await compressedFile.extract();
        downloadBlob(extracted, getDownloadName(name));
      }
    }
  };

  const handleDownloadOriginalArchive = () => {
    if (!isArchiveRoute(fileRoute)) return;

    if (remoteArchiveUrlRef.current) {
      const url = remoteArchiveUrlRef.current;
      const link = document.createElement("a");
      link.href = url;
      link.download = headerFileName;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }

    if (originalUploadedFile) {
      const url = URL.createObjectURL(originalUploadedFile);
      const link = document.createElement("a");
      link.href = url;
      link.download = headerFileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    }
  };

  const handleDownloadFile = () => {
    const downloadUrl = previewUrl ?? currentFileUrl;
    if (!downloadUrl) return;

    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = headerFileName;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadOriginalFile = () => {
    const downloadUrl = currentFileUrl ?? previewUrl;
    if (!downloadUrl) return;

    if (downloadUrl.startsWith("http://") || downloadUrl.startsWith("https://")) {
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = headerFileName;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.open(downloadUrl, "_blank", "noopener,noreferrer");
      return;
    }

    handleDownloadFile();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadFromSource(file.name, file);
    e.target.value = "";
  };

  const panelTitle = isArchiveRoute(fileRoute)
    ? "Files inside archive"
    : fileRoute === "image"
      ? "Image preview"
      : fileRoute === "video"
        ? "Video preview"
        : fileRoute === "pdf"
          ? "PDF preview"
          : "File preview";

  const panelDescription = isArchiveRoute(fileRoute)
    ? "Select items to download from the preview"
    : fileRoute === "unsupported"
      ? "This format cannot be previewed in the browser"
      : fileRoute
        ? "Preview your file below"
        : "Upload a file or open a link to get started";

  const canDownloadOriginal = Boolean(currentFileUrl ?? previewUrl);
  const canDownloadSelected =
    isArchiveRoute(fileRoute) &&
    selectedFiles.size > 0 &&
    (fileRoute === "zip" ? Boolean(zipInstance) : rarFileMapRef.current.size > 0);

  const renderArchiveList = () => (
    <ul className="divide-y divide-gray-100" role="list">
      {extractedFiles.map((entry) => {
        const isChecked = selectedFiles.has(entry.name);
        return (
          <li key={entry.name}>
            <label className="group flex cursor-pointer items-center gap-4 px-5 py-3.5 transition-colors hover:bg-gray-50/80">
              <input
                type="checkbox"
                checked={isChecked}
                onChange={() => toggleSelectedFile(entry.name)}
                    className="size-4 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-600/30 focus:ring-offset-0"
              />
              <EntryIcon type={entry.type} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 group-hover:text-slate-900">
                {entry.name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-gray-400">
                {entry.size}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );

  const renderLeftContent = () => {
    if (isExtracting) {
      return (
        <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-gray-500">
          <span className="inline-block size-4 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />
          Extracting...
        </div>
      );
    }

    if (isArchiveRoute(fileRoute)) {
      return renderArchiveList();
    }

    if (fileRoute === "unsupported") {
      return (
        <div className="flex flex-col items-center gap-5 px-5 py-12 text-center">
          <p className="max-w-sm text-sm text-gray-600">
            Preview for this file format is not supported yet.
          </p>
          <button
            type="button"
            onClick={handleDownloadOriginalFile}
            disabled={!canDownloadOriginal}
            className="rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Download Original File
          </button>
        </div>
      );
    }

    if (!previewUrl || !fileRoute) return null;

    if (fileRoute === "image") {
      return (
        <div className="p-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt={headerFileName}
            className="h-auto w-full rounded-lg object-contain"
          />
        </div>
      );
    }

    if (fileRoute === "video") {
      return (
        <div className="p-5">
          <video
            src={previewUrl}
            controls
            className="h-auto w-full rounded-lg bg-black"
          >
            Your browser does not support video playback.
          </video>
        </div>
      );
    }

    if (fileRoute === "pdf") {
      return (
        <div className="p-5">
          <iframe
            src={previewUrl}
            title={headerFileName}
            className="h-[min(70vh,640px)] w-full rounded-lg border border-gray-200"
          />
        </div>
      );
    }

    return null;
  };

  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-900">
      <header className="sticky top-0 z-20 flex w-full items-center gap-4 border-b border-slate-200 bg-white px-4 py-3.5 text-slate-900 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:flex-none sm:basis-auto">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-50">
            <Archive className="size-5 text-blue-600" strokeWidth={1.75} />
          </div>
          <span className="truncate text-sm font-semibold tracking-tight text-slate-900 sm:text-base">
            Akira Utilities
          </span>
        </div>

        <p className="hidden min-w-0 flex-1 truncate text-center text-sm font-medium text-slate-600 sm:block md:text-[15px]">
          <span className="font-normal text-slate-500">{headerFileName}</span>
          <span className="mx-2 text-slate-300">·</span>
          <span>{headerFileSize}</span>
        </p>

        <div className="flex flex-1 items-center justify-end gap-3 sm:flex-none sm:basis-auto">
          <p className="min-w-0 flex-1 truncate text-right text-xs text-slate-500 sm:hidden">
            {headerFileName}
          </p>
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-100"
            aria-label="User account"
          >
            <User className="size-4.5 text-slate-600" strokeWidth={2} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-28 sm:px-6">
        <section className="w-full">
          <div className="overflow-hidden rounded-xl border border-gray-200/90 bg-white shadow-sm">
            <div className="border-b border-gray-100 bg-gray-50/80 px-5 py-4">
              <h1 className="text-[15px] font-semibold tracking-tight text-gray-900">
                {panelTitle}
              </h1>
              <p className="mt-0.5 text-sm text-gray-500">{panelDescription}</p>
            </div>

            {!fileRoute && (
              <div className="border-b border-gray-100 px-5 py-4">
                <label className="inline-flex cursor-pointer items-center justify-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus-within:outline-none focus-within:ring-2 focus-within:ring-blue-600/40 focus-within:ring-offset-2">
                  Select File to Test
                  <input
                    type="file"
                    accept=".zip,.rar,.jpg,.jpeg,.png,.webp,.gif,.mp4,.webm,.pdf"
                    onChange={handleFileUpload}
                    className="sr-only"
                  />
                </label>
              </div>
            )}

            {renderLeftContent()}
          </div>
        </section>
      </main>

      <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white px-4 py-4">
        <div className="mx-auto flex max-w-lg flex-wrap items-center justify-center gap-3 sm:gap-4">
          {isArchiveRoute(fileRoute) ? (
            <>
              <button
                type="button"
                onClick={handleDownload}
                disabled={!canDownloadSelected}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                Download Selected ({selectedFiles.size})
              </button>
              <button
                type="button"
                onClick={handleDownloadOriginalArchive}
                disabled={!remoteArchiveUrlRef.current && !originalUploadedFile}
                className="inline-flex items-center gap-2 rounded-lg border-2 border-blue-600 bg-transparent px-5 py-2.5 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="size-4 shrink-0" strokeWidth={2} />
                Download Full File
              </button>
            </>
          ) : fileRoute && fileRoute !== "unsupported" && previewUrl ? (
            <button
              type="button"
              onClick={handleDownloadFile}
              className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            >
              Download File
            </button>
          ) : fileRoute === "unsupported" && canDownloadOriginal ? (
            <button
              type="button"
              onClick={handleDownloadOriginalFile}
              className="inline-flex items-center gap-2 rounded-lg border-2 border-blue-600 bg-transparent px-5 py-2.5 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            >
              <Download className="size-4 shrink-0" strokeWidth={2} />
              Download Full File
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleCancelPreview}
            className="rounded-lg bg-slate-100 px-5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            Cancel Preview
          </button>
        </div>
      </footer>
    </div>
  );
}
