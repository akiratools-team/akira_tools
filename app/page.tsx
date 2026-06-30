"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import JSZip from "jszip";
import {
  Folder,
  FileText,
  Image as ImageIcon,
  File as FileIcon,
  Download,
  User,
  Archive,
  ArrowLeft,
} from "lucide-react";
import {
  buildListingWithFolders,
  formatArchiveSize,
  getArchiveEntryType,
  type ArchiveListingEntry,
} from "@/lib/archive-listing";
import { closeRarArchive, openRarArchive } from "@/lib/rar-client";
import {
  assertArchiveWithinLimit,
  assertLocalFileWithinLimit,
  RemoteFileTooLargeError,
  shouldUseStreamingMode,
  STREAMING_MODE_THRESHOLD_LABEL,
  streamFetchToBlob,
  type StreamFetchProgress,
} from "@/lib/stream-fetch";
import {
  createFileZipReader,
  createHttpZipReader,
  extractZipEntry,
  fetchRemoteArchiveSize,
  listZipEntries,
  NetworkInterruptedError,
  zipEntriesToListing,
  ZipRangeNotSupportedError,
  type ZipByteReader,
  type ZipEntryMeta,
} from "@/lib/zip-range";
import type { ArchiveReader } from "libarchive.js/dist/build/compiled/archive-reader";
import type { CompressedFile } from "libarchive.js/dist/build/compiled/compressed-file";

type FileRoute = "zip" | "rar" | "image" | "video" | "pdf" | "unsupported";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const VIDEO_EXTENSIONS = [".mp4", ".webm"];

function getFileUrlFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("fileurl") ?? "";
}

function hadFileUrlOnInitialLoad(): boolean {
  return Boolean(getFileUrlFromLocation());
}

function subscribeToFileUrl(onStoreChange: () => void): () => void {
  const notify = () => onStoreChange();

  window.addEventListener("popstate", notify);

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = (...args) => {
    originalPushState(...args);
    notify();
  };
  history.replaceState = (...args) => {
    originalReplaceState(...args);
    notify();
  };

  return () => {
    window.removeEventListener("popstate", notify);
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
  };
}

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

type ArchiveLoadMode = "memory" | "streaming" | null;

function getLoadErrorMessage(error: unknown, isRemote: boolean): string {
  if (error instanceof NetworkInterruptedError) {
    return error.message;
  }

  if (error instanceof ZipRangeNotSupportedError) {
    return error.message;
  }

  if (error instanceof RemoteFileTooLargeError) {
    return error.message;
  }

  if (error instanceof TypeError) {
    return isRemote
      ? "Unable to reach the file URL. This is often caused by a network failure or CORS restrictions on the host server."
      : "Unable to read the selected file. Please try uploading it again.";
  }

  if (error instanceof Error) {
    if (error.message.includes("Failed to fetch")) {
      return "The file could not be downloaded. Check the URL, network connection, and whether the server allows cross-origin access (CORS).";
    }
    if (
      error.message.toLowerCase().includes("corrupt") ||
      error.message.toLowerCase().includes("invalid")
    ) {
      return "The archive appears to be corrupt or in an unsupported format.";
    }
    return error.message;
  }

  return "Something went wrong while loading the file. Please try again.";
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
  const [headerFileName, setHeaderFileName] = useState("");
  const [headerFileSize, setHeaderFileSize] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [zipInstance, setZipInstance] = useState<JSZip | null>(null);
  const [fileRoute, setFileRoute] = useState<FileRoute | null>(null);
  const [inputUrl, setInputUrl] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [currentFileUrl, setCurrentFileUrl] = useState<string | null>(null);
  const [remoteArchiveUrl, setRemoteArchiveUrl] = useState<string | null>(null);
  const [hasLocalArchiveFile, setHasLocalArchiveFile] = useState(false);
  const [archiveLoadMode, setArchiveLoadMode] = useState<ArchiveLoadMode>(null);
  const [streamingZipCount, setStreamingZipCount] = useState(0);
  const [rarFileCount, setRarFileCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] =
    useState<StreamFetchProgress | null>(null);
  const [embeddedViaFileUrl] = useState(hadFileUrlOnInitialLoad);
  const [showUploadPanel, setShowUploadPanel] = useState(
    () => !hadFileUrlOnInitialLoad()
  );

  const fileurlParam = useSyncExternalStore(
    subscribeToFileUrl,
    getFileUrlFromLocation,
    () => ""
  );

  const rarReaderRef = useRef<ArchiveReader | null>(null);
  const rarFileMapRef = useRef<Map<string, CompressedFile>>(new Map());
  const streamingZipReaderRef = useRef<ZipByteReader | null>(null);
  const streamingZipEntriesRef = useRef<Map<string, ZipEntryMeta>>(new Map());
  const localArchiveFileRef = useRef<File | null>(null);
  const lastLoadedFileUrlRef = useRef<string | null>(null);

  const hasLoadedFile = Boolean(fileRoute);
  const shouldShowUploadSection = !fileRoute && showUploadPanel;
  const shouldShowBackToUpload = embeddedViaFileUrl && !showUploadPanel;

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
    setRarFileCount(0);
  }, []);

  const resetArchiveState = useCallback(() => {
    setSelectedFiles(new Set());
    setExtractedFiles([]);
    setZipInstance(null);
    setArchiveLoadMode(null);
    setStreamingZipCount(0);
    streamingZipReaderRef.current = null;
    streamingZipEntriesRef.current = new Map();
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
    setHeaderFileName("");
    setHeaderFileSize("");
    setSelectedFiles(new Set());
    setZipInstance(null);
    setFileRoute(null);
    setRemoteArchiveUrl(null);
    setHasLocalArchiveFile(false);
    setArchiveLoadMode(null);
    setStreamingZipCount(0);
    localArchiveFileRef.current = null;
    streamingZipReaderRef.current = null;
    streamingZipEntriesRef.current = new Map();
    setInputUrl("");
    setError(null);
    setDownloadProgress(null);
    setShowUploadPanel(true);
    lastLoadedFileUrlRef.current = null;
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
      setRarFileCount(fileMap.size);
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
      setError(null);
      setDownloadProgress(null);

      const extension = getFileExtension(source);
      const route = getRouteFromExtension(extension);
      const resolvedUrl = file ? URL.createObjectURL(file) : source;

      setFileRoute(route);
      setHeaderFileName(file?.name ?? getDisplayName(source));
      setCurrentFileUrl(resolvedUrl);
      resetArchiveState();
      localArchiveFileRef.current = null;
      setHasLocalArchiveFile(false);

      if (route === "zip" || route === "rar") {
        if (file) {
          localArchiveFileRef.current = file;
          setHasLocalArchiveFile(true);
          setRemoteArchiveUrl(null);
        } else {
          setRemoteArchiveUrl(source);
        }

        setIsExtracting(true);
        try {
          const archiveSize = file
            ? file.size
            : await fetchRemoteArchiveSize(source);

          if (archiveSize !== null) {
            assertArchiveWithinLimit(archiveSize);
            setHeaderFileSize(formatArchiveSize(archiveSize));
          }

          if (route === "rar" && shouldUseStreamingMode(archiveSize)) {
            throw new Error(
              `RAR archives larger than ${STREAMING_MODE_THRESHOLD_LABEL} are not supported in the browser. Use a ZIP archive or extract the file locally.`
            );
          }

          if (
            route === "zip" &&
            (shouldUseStreamingMode(archiveSize) ||
              (!file && archiveSize === null))
          ) {
            setArchiveLoadMode("streaming");
            const reader = file
              ? createFileZipReader(file)
              : createHttpZipReader(source);
            streamingZipReaderRef.current = reader;

            setDownloadProgress({
              loadedBytes: 0,
              totalBytes: archiveSize,
            });
            const entries = await listZipEntries(reader);
            const entryMap = new Map(entries.map((entry) => [entry.name, entry]));
            streamingZipEntriesRef.current = entryMap;
            setStreamingZipCount(entries.filter((entry) => !entry.isDir).length);
            setExtractedFiles(zipEntriesToListing(entries));
            setPreview(resolvedUrl);
            return;
          }

          setArchiveLoadMode("memory");
          let blob: Blob;
          if (file) {
            assertLocalFileWithinLimit(file);
            blob = file;
          } else {
            blob = await streamFetchToBlob(source, {
              validateZip: route === "zip",
              onProgress: setDownloadProgress,
            });
          }

          setPreview(resolvedUrl);
          await loadArchiveBlob(
            blob,
            file?.name ?? getDisplayName(source),
            route
          );
        } catch (loadError) {
          setExtractedFiles([]);
          setZipInstance(null);
          setRemoteArchiveUrl(null);
          setHasLocalArchiveFile(false);
          setArchiveLoadMode(null);
          setStreamingZipCount(0);
          localArchiveFileRef.current = null;
          streamingZipReaderRef.current = null;
          streamingZipEntriesRef.current = new Map();
          await clearRarArchive();
          setFileRoute(null);
          setPreview(null);
          setHeaderFileName("");
          setHeaderFileSize("");
          setCurrentFileUrl((current) => {
            if (current?.startsWith("blob:")) URL.revokeObjectURL(current);
            return null;
          });
          setError(getLoadErrorMessage(loadError, !file));
          setShowUploadPanel(true);
        } finally {
          setIsExtracting(false);
          setDownloadProgress(null);
        }
        return;
      }

      setIsExtracting(false);

      if (file) {
        assertArchiveWithinLimit(file.size);
        setPreview(resolvedUrl);
        setHeaderFileSize(formatArchiveSize(file.size));
        return;
      }

      try {
        const response = await fetch(source, { method: "HEAD" });
        if (!response.ok) {
          throw new Error(`Failed to fetch file (HTTP ${response.status}).`);
        }
        const contentLength = response.headers.get("content-length");
        if (contentLength) {
          const sizeBytes = Number(contentLength);
          if (!Number.isNaN(sizeBytes)) {
            assertArchiveWithinLimit(sizeBytes);
            setHeaderFileSize(formatArchiveSize(sizeBytes));
          }
        }
        setPreview(resolvedUrl);
      } catch (loadError) {
        setFileRoute(null);
        setPreview(null);
        setHeaderFileName("");
        setHeaderFileSize("");
        setCurrentFileUrl(null);
        setError(getLoadErrorMessage(loadError, true));
        setShowUploadPanel(true);
        return;
      }
    },
    [clearRarArchive, loadArchiveBlob, resetArchiveState, setPreview]
  );

  useEffect(() => {
    if (!fileurlParam) {
      lastLoadedFileUrlRef.current = null;
      return;
    }

    if (fileurlParam === lastLoadedFileUrlRef.current) return;

    lastLoadedFileUrlRef.current = fileurlParam;
    setInputUrl(fileurlParam);

    const frameId = requestAnimationFrame(() => {
      void loadFromSource(fileurlParam);
    });

    return () => cancelAnimationFrame(frameId);
  }, [fileurlParam, loadFromSource]);

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

    if (fileRoute === "zip" && archiveLoadMode === "streaming") {
      const reader = streamingZipReaderRef.current;
      if (!reader) return;

      try {
        for (const name of selectedFiles) {
          const entry = streamingZipEntriesRef.current.get(name);
          if (!entry || entry.isDir) continue;
          const extracted = await extractZipEntry(reader, entry);
          downloadBlob(
            new Blob([extracted as BlobPart]),
            getDownloadName(name)
          );
        }
      } catch (downloadError) {
        setError(getLoadErrorMessage(downloadError, Boolean(remoteArchiveUrl)));
        setShowUploadPanel(true);
      }
      return;
    }

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

    if (remoteArchiveUrl) {
      window.open(remoteArchiveUrl, "_blank", "noopener,noreferrer");
      return;
    }

    if (localArchiveFileRef.current) {
      const url = URL.createObjectURL(localArchiveFileRef.current);
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

    if (
      downloadUrl.startsWith("http://") ||
      downloadUrl.startsWith("https://")
    ) {
      window.open(downloadUrl, "_blank", "noopener,noreferrer");
      return;
    }

    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = headerFileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadOriginalFile = () => {
    const downloadUrl = currentFileUrl ?? previewUrl;
    if (!downloadUrl) return;

    if (
      downloadUrl.startsWith("http://") ||
      downloadUrl.startsWith("https://")
    ) {
      window.open(downloadUrl, "_blank", "noopener,noreferrer");
      return;
    }

    handleDownloadFile();
  };

  const handleLoadFromInput = () => {
    const trimmed = inputUrl.trim();
    if (!trimmed) return;

    lastLoadedFileUrlRef.current = trimmed;

    const url = new URL(window.location.href);
    url.searchParams.set("fileurl", trimmed);
    window.history.pushState({}, "", url.toString());

    if (embeddedViaFileUrl) {
      setShowUploadPanel(false);
    }

    void loadFromSource(trimmed);
  };

  const handleBackToUpload = () => {
    setShowUploadPanel(true);
    handleCancelPreview();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    lastLoadedFileUrlRef.current = null;
    setError(null);
    await loadFromSource(file.name, file);
    e.target.value = "";
  };

  const panelTitle = error
    ? "Unable to load file"
    : isArchiveRoute(fileRoute)
      ? "Files inside archive"
      : fileRoute === "image"
        ? "Image preview"
        : fileRoute === "video"
          ? "Video preview"
          : fileRoute === "pdf"
            ? "PDF preview"
            : "File preview";

  const panelDescription = error
    ? "Review the error below and try again with a different file or URL."
    : isArchiveRoute(fileRoute)
      ? archiveLoadMode === "streaming"
        ? "Browse files and download only what you need"
        : "Select items to download from the preview"
      : fileRoute === "unsupported"
        ? "This format cannot be previewed in the browser"
        : fileRoute
          ? "Preview your file below"
          : "Upload a file or open a link to get started";

  const canDownloadOriginal = Boolean(currentFileUrl ?? previewUrl);
  const canDownloadSelected =
    isArchiveRoute(fileRoute) &&
    selectedFiles.size > 0 &&
    (fileRoute === "zip"
      ? archiveLoadMode === "streaming"
        ? streamingZipCount > 0
        : Boolean(zipInstance)
      : rarFileCount > 0);
  const canDownloadFullArchive = Boolean(remoteArchiveUrl || hasLocalArchiveFile);

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
    if (error) {
      const isSizeWarning = error.includes("browser safety limit");
      return (
        <div
          className={
            isSizeWarning
              ? "mx-5 my-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900"
              : "mx-5 my-6 rounded-lg border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800"
          }
          role="alert"
        >
          <p className="font-semibold">
            {isSizeWarning ? "File too large for browser preview" : "Could not load the file"}
          </p>
          <p className="mt-1">{error}</p>
        </div>
      );
    }

    if (isExtracting) {
      const progressLabel =
        archiveLoadMode === "streaming" || downloadProgress?.loadedBytes === 0
          ? "Opening archive..."
          : downloadProgress && downloadProgress.loadedBytes > 0
            ? downloadProgress.totalBytes
              ? `Downloading... ${formatArchiveSize(downloadProgress.loadedBytes)} / ${formatArchiveSize(downloadProgress.totalBytes)}`
              : `Downloading... ${formatArchiveSize(downloadProgress.loadedBytes)}`
            : "Extracting...";

      return (
        <div className="flex flex-col items-center justify-center gap-2 px-5 py-10 text-sm text-gray-500">
          <div className="flex items-center gap-2">
            <span className="inline-block size-4 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />
            {progressLabel}
          </div>
          {downloadProgress?.totalBytes ? (
            <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-blue-600 transition-all duration-200"
                style={{
                  width: `${Math.min(
                    100,
                    (downloadProgress.loadedBytes / downloadProgress.totalBytes) * 100
                  )}%`,
                }}
              />
            </div>
          ) : null}
        </div>
      );
    }

    if (isArchiveRoute(fileRoute)) {
      return (
        <>
          {renderArchiveList()}
        </>
      );
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

        {hasLoadedFile && (
          <p className="hidden min-w-0 flex-1 truncate text-center text-sm font-medium text-slate-600 sm:block md:text-[15px]">
            <span className="font-normal text-slate-500">{headerFileName}</span>
            {headerFileSize ? (
              <>
                <span className="mx-2 text-slate-300">·</span>
                <span>{headerFileSize}</span>
              </>
            ) : null}
          </p>
        )}

        <div className="flex flex-1 items-center justify-end gap-3 sm:flex-none sm:basis-auto">
          {hasLoadedFile && (
            <p className="min-w-0 flex-1 truncate text-right text-xs text-slate-500 sm:hidden">
              {headerFileName}
            </p>
          )}
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
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h1 className="text-[15px] font-semibold tracking-tight text-gray-900">
                    {panelTitle}
                  </h1>
                  <p className="mt-0.5 text-sm text-gray-500">
                    {panelDescription}
                  </p>
                </div>
                {shouldShowBackToUpload && (
                  <button
                    type="button"
                    onClick={handleBackToUpload}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 focus-visible:ring-offset-2"
                    title="Back to upload"
                  >
                    <ArrowLeft className="size-3.5 shrink-0" strokeWidth={2} />
                    Back to upload
                  </button>
                )}
              </div>
            </div>

            {shouldShowUploadSection && (
              <div className="flex flex-col gap-5 border-b border-gray-100 px-5 py-6">
                <div className="flex w-full items-center gap-3">
                  <input
                    type="text"
                    placeholder="Dán đường link file ZIP/RAR vào đây..."
                    value={inputUrl}
                    onChange={(e) => setInputUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleLoadFromInput();
                    }}
                    className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={handleLoadFromInput}
                    className="whitespace-nowrap rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                  >
                    Tải & Xem trước
                  </button>
                </div>

                <div className="flex items-center justify-center gap-4 text-sm text-gray-400">
                  <span className="h-px flex-1 bg-gray-200" />
                  Hoặc
                  <span className="h-px flex-1 bg-gray-200" />
                </div>

                <label className="inline-flex cursor-pointer items-center justify-center rounded-lg bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus-within:outline-none focus-within:ring-2 focus-within:ring-slate-400 focus-within:ring-offset-2">
                  Tải file từ máy tính (Select File)
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
                disabled={!canDownloadFullArchive}
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
            disabled={!hasLoadedFile && !error}
            className="rounded-lg bg-slate-100 px-5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel Preview
          </button>
        </div>
      </footer>
    </div>
  );
}
