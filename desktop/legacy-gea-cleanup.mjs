import { lstat, readFile, realpath, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import { basename, join, resolve, relative, win32 } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { collectPluginStorage } from "./plugin-storage.mjs";
import { withPluginStoreLock } from "./plugin-store-lock.mjs";

const gea = "@cleverc2200/gea-dsh-prototype";
const graphFiles = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "npm-shrinkwrap.json",
  "node_modules",
  "packages",
  "version.json",
  "layer.json",
]);
const execute = promisify(execFile);
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function legacyGeaInUse(data) {
  try {
    if (process.platform === "darwin") {
      const result = await execute("/usr/sbin/lsof", ["-t", "+D", data], {
        timeout: 5000,
        maxBuffer: 16384,
      });
      return Boolean(result.stdout.trim());
    }
    if (process.platform === "win32") {
      const command =
        "$ErrorActionPreference='Stop'; $root=$env:GEA_LEGACY_ROOT; $current=$env:GEA_CURRENT_EXE; $items=@(Get-CimInstance Win32_Process); if (!$items.Count) {throw 'No process inventory'}; $busy=@($items | Where-Object {(($_.Name -in @('node.exe','electron.exe')) -and (!$_.CommandLine -or !$_.ExecutablePath)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($_.Name -eq 'GEA Desktop.exe' -and (!$_.ExecutablePath -or $_.ExecutablePath -ne $current))}); Write-Output ($busy.Count -gt 0)";
      const { stdout } = await execute(
        win32.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(command, "utf16le").toString("base64"),
        ],
        {
          env: { ...process.env, GEA_LEGACY_ROOT: data, GEA_CURRENT_EXE: process.execPath },
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 16384,
        },
      );
      return stdout.trim() !== "False";
    }
  } catch (error) {
    if (process.platform === "darwin" && error.code === 1 && !error.stderr?.trim()) return false;
  }
  return true;
}

async function ownedGraph(path, id, receipt) {
  if (
    receipt?.id !== id ||
    receipt.state !== "prepared" ||
    receipt.pinned ||
    !/^0\.0\.\d+$/.test(receipt.versions?.[gea] ?? "")
  )
    return false;
  const manifest = await json(join(path, "package.json"));
  const packageNames = new Set([
    ...["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(
      (field) => Object.keys(manifest[field] ?? {}),
    ),
    ...Object.keys(receipt.dependencies ?? {}),
    ...Object.keys(receipt.versions ?? {}),
  ]);
  if (
    manifest.name !== "gea-desktop-runtime" ||
    !manifest.dependencies?.[gea] ||
    packageNames.size !== 1 ||
    !packageNames.has(gea)
  )
    return false;
  const bundles = manifest.dsh?.profile?.bundles;
  if (bundles !== undefined && (!Array.isArray(bundles) || bundles.some((name) => name !== gea)))
    return false;
  if ((await readdir(path)).some((file) => !graphFiles.has(file))) return false;
  const metadata = await lstat(join(path, "pnpm-lock.yaml"));
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    digest(await readFile(join(path, "pnpm-lock.yaml"))) !== receipt.lockSha256
  )
    return false;
  const installed = await json(join(path, "node_modules", gea, "package.json"));
  return installed.name === gea && installed.version === receipt.versions[gea];
}

export async function cleanupLegacyGea({ data, home, apply = false, isInUse = legacyGeaInUse }) {
  data = resolve(data);
  home = resolve(home);
  const empty = { removed: [], failed: [] };
  if (basename(data) !== "dsh-gea-desktop" || !relative(data, home).startsWith(".."))
    return { ...empty, skipped: "protected-data-root" };
  try {
    for (const path of [data, join(data, "plugins")]) {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (await realpath(path)) !== path)
        return { ...empty, skipped: "unsafe-legacy-root" };
    }
    const actualHome = await realpath(home).catch((error) => {
      if (error.code === "ENOENT") return home;
      throw error;
    });
    if (!relative(data, actualHome).startsWith(".."))
      return { ...empty, skipped: "protected-data-root" };
    for (const part of [
      "profiles",
      "profiles/desktop",
      "profiles/desktop/gea",
      "profiles/desktop/gea/legacy-cleanup",
    ]) {
      const entry = await lstat(join(home, part)).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
        return { ...empty, skipped: "unsafe-report-root" };
    }
    const config = await json(join(data, "gea.config.json"));
    if (typeof config.geaBaseUrl !== "string" || !config.analysis)
      return { ...empty, skipped: "unrecognized-legacy-gea" };
    if (await isInUse(data)) return { ...empty, skipped: "legacy-in-use-or-unknown" };
    const root = join(data, "plugins");
    const candidates = [];
    const store = {
      root,
      withLock: (action, options) =>
        apply ? withPluginStoreLock(root, action, options) : action(),
      status: () => json(join(root, "selection.json")),
      selected: async () => {
        const state = await store.status();
        if (state.active === "baseline") return;
        if (!/^channel-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(state.active))
          throw Error("LEGACY_SELECTION_UNKNOWN");
        const path = join(root, "versions", state.active);
        if (!(await ownedGraph(path, state.active, await json(join(path, "version.json")))))
          throw Error("LEGACY_SELECTION_UNKNOWN");
      },
    };
    const result = await collectPluginStorage(store, {
      collectCores: false,
      dryRun: !apply,
      canCollect: async (path, id, receipt) => {
        if (!(await ownedGraph(path, id, receipt)) || (await isInUse(data))) return false;
        candidates.push(id);
        return true;
      },
    });
    const report = { ...result, candidates, applied: apply };
    if (apply) {
      try {
        const reports = join(home, "profiles/desktop/gea/legacy-cleanup");
        await mkdir(reports, { recursive: true, mode: 0o700 });
        const temporary = join(reports, randomUUID() + ".json");
        await writeFile(
          temporary,
          JSON.stringify({ ...report, data, at: new Date().toISOString() }, null, 2) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        const latest = join(reports, randomUUID() + ".tmp");
        await writeFile(latest, await readFile(temporary), { flag: "wx", mode: 0o600 });
        await rename(latest, join(reports, "latest.json"));
      } catch (error) {
        return { ...report, reportError: error.code ?? "REPORT_FAILED" };
      }
    }
    return report;
  } catch (error) {
    if (error.code === "ENOENT") return { ...empty, skipped: "legacy-not-found" };
    return { ...empty, skipped: "legacy-state-unconfirmed" };
  }
}

if (
  process.argv[1] &&
  import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href
) {
  const { values } = (await import("node:util")).parseArgs({
    options: {
      "legacy-data": { type: "string" },
      home: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  if (!values["legacy-data"] || !values.home)
    throw Error(
      "Pass --legacy-data <dsh-gea-desktop> --home <current DSH home>; append --apply to clean",
    );
  console.log(
    JSON.stringify(
      await cleanupLegacyGea({
        data: values["legacy-data"],
        home: values.home,
        apply: values.apply,
      }),
      null,
      2,
    ),
  );
}
