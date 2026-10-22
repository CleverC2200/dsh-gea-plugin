import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export async function selectDownloadStore({ pnpm, home, store, coldDownload = false }) {
  assert(!(coldDownload && store !== undefined), "RECEPTION_STORE_OPTIONS_CONFLICT");
  let path = coldDownload ? join(home, "pnpm-store") : store;
  if (path === undefined) {
    assert(isAbsolute(pnpm ?? ""), "RECEPTION_PNPM_ABSOLUTE_REQUIRED");
    const result = spawnSync(process.execPath, [pnpm, "store", "path"], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert(!result.error && result.status === 0, "RECEPTION_STORE_RESOLUTION_FAILED");
    path = result.stdout.trim();
  }
  assert(
    typeof path === "string" && isAbsolute(path) && !/[\0\r\n]/.test(path),
    "RECEPTION_STORE_ABSOLUTE_REQUIRED",
  );
  let ancestor = path;
  for (;;) {
    try {
      assert((await stat(ancestor)).isDirectory(), "RECEPTION_STORE_DIRECTORY_REQUIRED");
      await access(ancestor, constants.W_OK | constants.X_OK);
      break;
    } catch (error) {
      if (error.code === "ENOENT" && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
      else throw Error("RECEPTION_STORE_DIRECTORY_REQUIRED");
    }
  }
  return { mode: coldDownload ? "cold" : "shared", path };
}
