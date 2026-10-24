import { appendFileSync } from "node:fs";
import { constants, enableCompileCache, getCompileCacheDir } from "node:module";
import { join } from "node:path";

const role = !process.env.GEA_RETURNED_COMPILE_CACHE_WRAPPER_PID
  ? "wrapper"
  : process.argv[1]?.replaceAll("\\", "/").endsWith("/apps/cli/lib/bin.js")
    ? "core"
    : "other";
const mode = process.env.GEA_RETURNED_COMPILE_CACHE_MODE;
const result = enableCompileCache(join(process.env.GEA_RETURNED_COMPILE_CACHE_DIR, role));
const cacheDirectory = getCompileCacheDir() ?? null;
if (process.env.GEA_TEST_LIFECYCLE_RECEIPT)
  appendFileSync(
    process.env.GEA_TEST_LIFECYCLE_RECEIPT,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "returned-compile-cache-process",
      testName: process.env.GEA_RETURNED_COMPILE_CACHE_TEST_NAME,
      directory: process.env.GEA_RETURNED_COMPILE_CACHE_RUNTIME,
      role,
      mode,
      pid: process.pid,
      ppid: process.ppid,
      node: process.version,
      status: result.status,
      statusName: Object.entries(constants.compileCacheStatus).find(
        ([, status]) => status === result.status,
      )?.[0],
      enabled: cacheDirectory !== null,
      cacheDirectory,
    }) + "\n",
    { mode: 0o600 },
  );
if (role === "wrapper") process.env.GEA_RETURNED_COMPILE_CACHE_WRAPPER_PID = String(process.pid);
