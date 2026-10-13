/** Official package-operation entry; no profile SDK links, overlays, peer bypasses or auxiliary inputs. */
import { readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const v = JSON.parse(await readFile(process.argv[2], "utf8"));
const { runProfilePnpm } = await import(
  pathToFileURL(join(v.core, "packages/boot/plugin-manager/lib/types/operations.js"))
);
const require = createRequire(join(v.core, "apps/cli/package.json"));
const { withFileLock } = await import(
  pathToFileURL(require.resolve("@deepseek-ai/dsh-atomic-write"))
);
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
const result = await withFileLock(join(v.profile, "package.json"), () =>
  runProfilePnpm(
    {
      profile: basename(v.profile),
      home: v.home,
      dir: v.profile,
      cwd: v.profile,
      installAnchor: join(v.core, "apps/cli/package.json"),
    },
    [
      "add",
      ...v.artifacts.map((row) => row.file),
      "--registry=https://registry.npmjs.org",
      "--store-dir=" + join(v.home, "pnpm-store"),
      "--config.cache-dir=" + join(v.home, "pnpm-cache"),
    ],
    {
      execution: "service",
      command: process.execPath,
      args: [v.pnpm],
      env: { ...process.env },
      signal: controller.signal,
      outputBytes: 16000,
      lookupTimeoutMs: 30000,
      idleTimeoutMs: 60000,
    },
  ),
);
await writeFile(
  v.receipt + ".installation.json",
  JSON.stringify(
    {
      exitCode: result.exitCode,
      incompatible: result.incompatible ?? [],
      timedOut: result.timedOut ?? false,
      logPath: result.logPath,
      outputOmitted: true,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
process.exitCode = result.exitCode;
