import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export function compileCacheEnvironment(cache, { runtime, testName, env }) {
  if (!cache) return {};
  if (!["on", "off"].includes(cache.mode) || !isAbsolute(cache.directory ?? ""))
    throw Error("RETURNED_COMPILE_CACHE_CONFIGURATION_INVALID");
  if (cache.mode === "on" && env.NODE_V8_COVERAGE)
    throw Error("RETURNED_COMPILE_CACHE_COVERAGE_CONFLICT");
  return {
    NODE_COMPILE_CACHE: undefined,
    NODE_DISABLE_COMPILE_CACHE: cache.mode === "off" ? "1" : undefined,
    NODE_COMPILE_CACHE_PORTABLE: undefined,
    NODE_OPTIONS: [
      env.NODE_OPTIONS,
      `--import=${new URL("./returned-compile-cache-probe.mjs", import.meta.url).href}`,
    ]
      .filter(Boolean)
      .join(" "),
    GEA_RETURNED_COMPILE_CACHE_DIR: cache.directory,
    GEA_RETURNED_COMPILE_CACHE_MODE: cache.mode,
    GEA_RETURNED_COMPILE_CACHE_WRAPPER_PID: undefined,
    GEA_RETURNED_COMPILE_CACHE_RUNTIME: runtime,
    GEA_RETURNED_COMPILE_CACHE_TEST_NAME: testName,
  };
}

export async function compileCacheFiles(cache) {
  const count = async (directory) => {
    const total = { files: 0, bytes: 0 };
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return total;
      throw error;
    }
    for (const entry of entries) {
      const file = join(directory, entry.name);
      const size = entry.isDirectory()
        ? await count(file)
        : { files: 1, bytes: (await stat(file)).size };
      total.files += size.files;
      total.bytes += size.bytes;
    }
    return total;
  };
  return {
    wrapper: await count(join(cache.directory, "wrapper")),
    core: await count(join(cache.directory, "core")),
    other: await count(join(cache.directory, "other")),
  };
}
