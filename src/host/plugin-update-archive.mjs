import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { list } from "tar";

export async function archiveMatches(archive, packageDirectory, signal) {
  const root = resolve(packageDirectory),
    files = new Map(),
    seen = new Set();
  const limit = 32 * 1024 * 1024;
  let valid = true,
    indexBytes = 0;
  const parser = list({
    strict: true,
    onReadEntry(entry) {
      if (entry.type === "Directory") return;
      const name = entry.path;
      indexBytes += Buffer.byteLength(name);
      const target = resolve(root, name.slice("package/".length));
      const inside = relative(root, target);
      if (
        !["File", "OldFile"].includes(entry.type) ||
        !name.startsWith("package/") ||
        seen.has(name) ||
        !inside ||
        isAbsolute(inside) ||
        inside === ".." ||
        inside.startsWith(".." + sep) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > limit ||
        indexBytes > limit
      ) {
        valid = false;
        return;
      }
      seen.add(name);
      const digest = createHash("sha256");
      entry.on("data", (chunk) => digest.update(chunk));
      entry.on("end", () => files.set(target, digest.digest("hex")));
    },
  });
  await pipeline(createReadStream(archive), parser, { signal });
  if (!valid || files.size === 0 || files.size !== seen.size) return false;
  for (const [path, expected] of files) {
    signal?.throwIfAborted();
    if ((await lstat(path)).isSymbolicLink()) return false;
    const actual = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (actual !== expected) return false;
  }
  return true;
}
