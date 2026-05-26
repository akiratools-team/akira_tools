import { cpSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "libarchive.js", "dist");
const dest = join(root, "public", "libarchive");

mkdirSync(dest, { recursive: true });
cpSync(join(src, "worker-bundle.js"), join(dest, "worker-bundle.js"));
cpSync(join(src, "libarchive.wasm"), join(dest, "libarchive.wasm"));

console.log("Copied libarchive.js worker assets to public/libarchive/");
