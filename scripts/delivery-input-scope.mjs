/** One read scope for delivery metadata, Git objects, source and canonical artifact validation. */
import { realpath, lstat, readFile } from "node:fs/promises";
import {
  resolve,
  relative,
  isAbsolute,
  dirname,
  basename,
  join,
} from "node:path";
const fail = (code) => {
  throw Error(code);
};
const sensitive = (path) =>
  path
    .split("/")
    .some((part) =>
      /^(?:\.env(?:\..*)?|(?:credentials?|authlogs?|authentication-logs?)(?:\.[a-z0-9_-]+)?|gea\.config\.json|id_(?:rsa|ed25519)|[^/]*\.(?:pem|key))$/i.test(
        part,
      ),
    );
const within = (root, path) => {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith("../") && !isAbsolute(value);
};
// Resolve missing persistent directories from the closest real ancestor without creating or walking them.
async function persistentLocation(path) {
  const suffix = [];
  let ancestor = path;
  while (true) {
    try {
      return join(await realpath(ancestor), ...suffix);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}
export async function createReadScope(root, persistentRefs = []) {
  const protectedPaths = [];
  let unresolved = false;
  for (const ref of persistentRefs) {
    if (!ref || typeof ref.path !== "string") {
      unresolved = true;
      continue;
    }
    const lexical = resolve(root, ref.path);
    try {
      protectedPaths.push(lexical, await persistentLocation(lexical));
    } catch {
      unresolved = true;
    }
  }
  function guard(path, traverse) {
    if (unresolved) fail("INTEGRITY_PERSISTENT_SCOPE_UNRESOLVED");
    if (
      protectedPaths.some(
        (protectedPath) =>
          within(protectedPath, path) ||
          (traverse && within(path, protectedPath)),
      )
    )
      fail("INTEGRITY_PERSISTENT_OVERLAP");
    if (!within(root, path)) fail("INTEGRITY_INPUT_OUTSIDE_ROOT");
    if (sensitive(relative(root, path)))
      fail("INTEGRITY_SOURCE_SCOPE_UNSUPPORTED");
  }
  async function location(path, { traverse = false } = {}) {
    if (typeof path !== "string") fail("INTEGRITY_SOURCE_SCOPE_UNSUPPORTED");
    const lexical = resolve(root, path);
    guard(lexical, traverse);
    const physical = await realpath(lexical);
    guard(physical, traverse);
    // realpath cannot expose other hardlink names. Do not read or traverse a
    // file whose independent scope cannot be proved without scanning Session.
    const info = await lstat(physical);
    if (info.isFile() && info.nlink !== 1)
      fail("INTEGRITY_MULTILINK_UNVERIFIABLE");
    return physical;
  }
  async function read(path, limit = 16 * 1024 * 1024) {
    const file = await location(path, { traverse: true }),
      info = await lstat(file);
    if (info.isFile() && info.nlink !== 1)
      fail("INTEGRITY_MULTILINK_UNVERIFIABLE");
    if (!info.isFile() || info.size > limit)
      fail("INTEGRITY_INPUT_UNSUPPORTED");
    const bytes = await readFile(file);
    if (bytes.length > limit) fail("INTEGRITY_INPUT_UNSUPPORTED");
    return bytes;
  }
  async function optional(path) {
    try {
      return await read(path);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  return { root, resolve: location, read, optional };
}
