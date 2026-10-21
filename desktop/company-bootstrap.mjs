import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile, lstat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  refreshBundledGea,
  assertCompletedGeaRefresh,
  assertProfileIdle,
} from "./company-gea-refresh.mjs";
import { prepareCompanyArchives, repointCompanyArchives } from "./company-archives.mjs";
import { cleanupLegacyGea } from "./legacy-gea-cleanup.mjs";

const names = [
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "@cleverc2200/gea-dsh-prototype",
  "@changfenhuang/dsh-genui",
];
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const desktopCoreHeads = new Set([
  "639ed015397290b3745d163aafe02ffee4aa3f84",
  "8cfb899ccf21d3662421b99b5f4627842ef712ea",
]);
const desktopCoreVersion = "0.2.0-rc.2";

function validCoreArtifacts(artifacts) {
  return (
    Array.isArray(artifacts) &&
    artifacts.length > 0 &&
    artifacts.every(
      (row) =>
        typeof row?.path === "string" &&
        !isAbsolute(row.path) &&
        row.path.split(/[\\/]/).every((part) => part && part !== "." && part !== "..") &&
        /^[a-f0-9]{64}$/.test(row.sha256),
    ) &&
    new Set(artifacts.map((row) => row.path)).size === artifacts.length
  );
}

export function planCompanyCoreRefresh(updates, core, source) {
  if (updates === undefined) {
    if (source === undefined) return undefined;
    updates = { source, core };
  } else if (updates.source === undefined && source !== undefined) {
    updates = { ...updates, source };
  }
  const previous = updates?.core;
  if (
    !previous ||
    !core ||
    [previous, core].some((proof) =>
      Object.keys(proof).some(
        (key) => !["kind", "root", "head", "version", "artifacts"].includes(key),
      ),
    ) ||
    previous.kind !== "desktop" ||
    core.kind !== "desktop" ||
    !desktopCoreHeads.has(previous.head) ||
    !desktopCoreHeads.has(core.head) ||
    previous.version !== desktopCoreVersion ||
    core.version !== desktopCoreVersion ||
    typeof previous.root !== "string" ||
    !isAbsolute(previous.root) ||
    typeof core.root !== "string" ||
    !isAbsolute(core.root) ||
    !validCoreArtifacts(previous.artifacts) ||
    !validCoreArtifacts(core.artifacts) ||
    JSON.stringify(previous.artifacts.map((row) => row.path).sort()) !==
      JSON.stringify(core.artifacts.map((row) => row.path).sort())
  )
    throw Error("GEA_CORE_REFRESH_REJECTED");
  for (const [key, maximum] of [
    ["checkTimeoutMs", 120000],
    ["pollIntervalMs", 30000],
  ])
    if (
      updates[key] !== undefined &&
      (!Number.isSafeInteger(updates[key]) || updates[key] < 1000 || updates[key] > maximum)
    )
      throw Error("GEA_CORE_REFRESH_REJECTED");
  return {
    ...updates,
    core,
    checkTimeoutMs: updates.checkTimeoutMs ?? 60000,
    pollIntervalMs: updates.pollIntervalMs ?? 2000,
  };
}

async function verifyCompanyCore(root, core) {
  const app = await json(join(root, "package.json"));
  const runtime = await json(join(root, "dsh/package.json"));
  if (
    !desktopCoreHeads.has(core?.head) ||
    core.version !== desktopCoreVersion ||
    !validCoreArtifacts(core.artifacts) ||
    app.dshBuildCommit !== core.head ||
    runtime.name !== "@deepseek-ai/dsh-desktop-runtime" ||
    runtime.version !== core.version ||
    app.dshBuildDirty !== false
  )
    throw Error("GEA_SEED_CORE_MISMATCH");
  for (const artifact of core.artifacts)
    if (digest(await readFile(join(root, artifact.path))) !== artifact.sha256)
      throw Error("GEA_SEED_CORE_CHANGED");
  return { ...core, root, kind: "desktop" };
}

export async function refreshCompanyCore({ root, seed, home, apply = true }) {
  const profile = join(home, "profiles/desktop");
  const patch = join(profile, "cordis.patch.yml");
  if (!existsSync(patch)) return { status: "no-update-configuration", changed: false };
  const require = createRequire(join(root, "dsh/package.json"));
  const YAML = require("yaml");
  const { withFileLock, writeFileAtomic } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-atomic-write"))
  );
  return withFileLock(
    join(profile, "package.json"),
    async () => {
      const original = await readFile(patch, "utf8");
      const document = YAML.parseDocument(original);
      if (document.errors.length || !Array.isArray(document.toJS()))
        throw Error("GEA_PROFILE_PATCH_INVALID");
      const rows = document.toJS();
      const index = rows.findIndex(
        (row) => row?.id === "gea-proof" || row?.name === "@cleverc2200/gea-dsh-prototype",
      );
      if (index === -1) return { status: "no-update-configuration", changed: false };
      const updates = rows[index]?.config?.pluginUpdates;
      const manifest = await json(join(seed, "manifest.json"));
      const core = await verifyCompanyCore(root, manifest.core);
      if (updates?.source === undefined && manifest.source === undefined)
        throw Error("GEA_SEED_UPDATE_SOURCE_MISSING");
      const next = planCompanyCoreRefresh(updates, core, manifest.source);
      if (JSON.stringify(next) === JSON.stringify(updates))
        return { status: "current-core-proof", changed: false };
      if (!apply) return { status: "ready", changed: false };
      const backup = join(
        profile,
        "gea/bootstrap",
        "before-core-proof-" + digest(original) + ".yml",
      );
      if (!existsSync(backup))
        await writeFileAtomic(backup, original, {
          mode: 0o600,
          dirMode: 0o700,
        });
      if (updates === undefined) document.setIn([index, "config", "pluginUpdates"], next);
      else {
        document.setIn([index, "config", "pluginUpdates", "core"], next.core);
        for (const key of ["source", "checkTimeoutMs", "pollIntervalMs"])
          if (updates[key] === undefined)
            document.setIn([index, "config", "pluginUpdates", key], next[key]);
      }
      await writeFileAtomic(patch, document.toString(), { mode: 0o600 });
      return {
        status: updates?.source === undefined ? "update-source-configured" : "core-proof-refreshed",
        changed: true,
        backup,
      };
    },
    { waitMs: 120000 },
  );
}

async function assertCompletedInstallation(record, profile) {
  let receipt;
  try {
    receipt = await json(join(record, "receipt.json"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw Error("GEA_COMPANY_INSTALL_INCOMPLETE", { cause: error });
  }
  if (receipt?.status === "installed") return receipt;
  try {
    const prefix = "GEA_COMPANY_INSTALL_FAILED: ";
    if (
      receipt?.status !== "failed" ||
      typeof receipt.diagnostic !== "string" ||
      !receipt.diagnostic.startsWith(prefix) ||
      existsSync(join(record, "before-store-conflict-retry.json"))
    )
      throw Error("NOT_RECOVERABLE");
    const log = receipt.diagnostic.slice(prefix.length);
    const local = relative(join(profile, ".plugin-manager/logs"), log).split(/[\\/]/);
    if (
      !isAbsolute(log) ||
      local.length !== 2 ||
      !/^operation-[a-zA-Z0-9_-]+$/.test(local[0]) ||
      local[1] !== "pnpm.log" ||
      !(await readFile(log, "utf8")).startsWith("[ERR_PNPM_UNEXPECTED_STORE]")
    )
      throw Error("NOT_RECOVERABLE");
    const current = await json(join(profile, "package.json"));
    if (names.every((name) => current.dependencies?.[name])) throw Error("NOT_RECOVERABLE");
    for (const file of [
      "package.json",
      "cordis.patch.yml",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ])
      if (
        !(await readFile(join(profile, file))).equals(
          await readFile(join(record, "before-" + file)),
        )
      )
        throw Error("PROFILE_CHANGED");
    return receipt;
  } catch (error) {
    throw Error("GEA_COMPANY_INSTALL_INCOMPLETE", { cause: error });
  }
}

export async function readCompanySeed(seed) {
  const manifest = await json(join(seed, "manifest.json"));
  if (
    manifest.schema !== 1 ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length < 3 ||
    manifest.packages.length > names.length
  )
    throw Error("GEA_SEED_INVALID");
  for (const [index, row] of manifest.packages.entries()) {
    if (
      row.name !== names[index] ||
      typeof row.version !== "string" ||
      !row.version ||
      typeof row.file !== "string" ||
      basename(row.file) !== row.file ||
      !row.file.endsWith(".tgz") ||
      !/^[a-f0-9]{64}$/.test(row.sha256)
    )
      throw Error("GEA_SEED_INVALID");
    if (digest(await readFile(join(seed, "archives", row.file))) !== row.sha256)
      throw Error("GEA_SEED_ARCHIVE_CHANGED");
  }
  if (
    manifest.dependencyLockSha256 !== undefined &&
    digest(await readFile(join(seed, "dependency-lock.yaml"))) !== manifest.dependencyLockSha256
  )
    throw Error("GEA_SEED_DEPENDENCY_LOCK_CHANGED");
  return manifest;
}

export function relocateCompanyLock(lock, replacements) {
  let text = JSON.stringify(lock);
  for (const [before, after] of replacements)
    text = text.replaceAll(JSON.stringify(before).slice(1, -1), JSON.stringify(after).slice(1, -1));
  return JSON.parse(text);
}

export async function writeCompanySeedLock({ root, seed, profile }) {
  const require = createRequire(join(root, "dsh/package.json"));
  const YAML = require("yaml");
  const manifest = await readCompanySeed(seed);
  const lock = YAML.parse(await readFile(join(profile, "pnpm-lock.yaml"), "utf8"));
  const replacements = [];
  for (const row of manifest.packages) {
    const dependency = lock.importers?.["."]?.dependencies?.[row.name];
    if (!dependency?.specifier?.startsWith("file:") || !dependency.version?.startsWith("file:"))
      throw Error("GEA_SEED_DEPENDENCY_LOCK_INVALID");
    const portable = "file:company-seed/archives/" + row.file;
    replacements.push(
      [dependency.specifier, portable],
      [dependency.version.slice(0, dependency.version.indexOf(row.file) + row.file.length), portable],
    );
  }
  const bytes = YAML.stringify(relocateCompanyLock(lock, replacements));
  await writeFile(join(seed, "dependency-lock.yaml"), bytes, { flag: "wx" });
  manifest.dependencyLockSha256 = digest(bytes);
  await writeFile(join(seed, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

export async function installCompanyPackages({
  root,
  support,
  home,
  profile,
  packages,
  store,
  offline,
  beforeInstall,
  complete,
  strictPeers = false,
  seed,
}) {
  const anchor = join(root, "dsh/node_modules/@deepseek-ai/dsh/package.json");
  const require = createRequire(anchor);
  const boot = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-app-boot")));
  const { runProfilePnpm } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-plugin-manager/operations"))
  );
  const { withFileLock, writeFileAtomic } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-atomic-write"))
  );
  await mkdir(profile, { recursive: true, mode: 0o700 });
  return withFileLock(
    join(profile, "package.json"),
    async () => {
      await beforeInstall?.();
      const modulesPath = join(profile, "node_modules/.modules.yaml");
      let selectedStore = store;
      let offlineArguments = offline ? ["--offline"] : [];
      if (existsSync(modulesPath)) {
        const modules = require("yaml").parse(await readFile(modulesPath, "utf8"));
        if (typeof modules?.storeDir !== "string" || !isAbsolute(modules.storeDir))
          throw Error("GEA_COMPANY_STORE_INVALID");
        selectedStore = modules.storeDir;
        if (offline && selectedStore !== join(store, "v11"))
          offlineArguments = ["--prefer-offline"];
      }
      const archives = seed
        ? await prepareCompanyArchives({ root, seed, home, profile, packages })
        : { packages, replacements: [] };
      await repointCompanyArchives({
        root,
        profile,
        replacements: archives.replacements,
        writeFileAtomic,
      });
      boot.initProfile(profile, boot.PROFILE_TEMPLATES.web.bundles);
      const current = await json(join(profile, "package.json"));
      const hasUserDependencies = Object.keys(current.dependencies ?? {}).length > 0;
      if (offline && hasUserDependencies) offlineArguments = ["--prefer-offline"];
      const lockPath = join(profile, "pnpm-lock.yaml");
      const previousLock = existsSync(lockPath) ? await readFile(lockPath) : undefined;
      let seededLock = false;
      if (offline && seed && !hasUserDependencies && previousLock === undefined) {
        const manifest = await readCompanySeed(seed);
        if (manifest.dependencyLockSha256) {
          if (archives.packages.length !== manifest.packages.length)
            throw Error("GEA_SEED_DEPENDENCY_LOCK_PARTIAL_INSTALL");
          const YAML = require("yaml");
          const lock = YAML.parse(await readFile(join(seed, "dependency-lock.yaml"), "utf8"));
          const replacements = manifest.packages.map((row, index) => [
            "file:company-seed/archives/" + row.file,
            "file:" + relative(profile, archives.packages[index]).replaceAll("\\", "/"),
          ]);
          const relocated = relocateCompanyLock(lock, replacements);
          for (const [index, row] of manifest.packages.entries())
            relocated.importers["."].dependencies[row.name].specifier =
              "file:" + archives.packages[index].replaceAll("\\", "/");
          await writeFileAtomic(lockPath, YAML.stringify(relocated), { mode: 0o600 });
          seededLock = true;
        }
      }
      let result;
      try {
        result = await runProfilePnpm(
          {
            profile: "desktop",
            dir: profile,
            home,
            cwd: profile,
            installAnchor: anchor,
          },
          [
            "add",
            ...archives.packages,
            ...offlineArguments,
            ...(seededLock ? ["--config.frozen-lockfile=true"] : []),
            ...(strictPeers
              ? ["--strict-peer-dependencies", "--config.auto-install-peers=false"]
              : []),
            "--registry=https://registry.npmjs.org",
            "--store-dir=" + selectedStore,
            "--config.cache-dir=" + join(home, "desktop-company-cache", "metadata"),
          ],
          {
            execution: "service",
            command: process.execPath,
            args: ["--expose-internals", join(support, "pnpm/bin/pnpm.mjs")],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
              DSH_HOME: home,
              PATH: join(support, "bin") + delimiter + (process.env.PATH ?? ""),
            },
            outputBytes: 16000,
            idleTimeoutMs: 120000,
            lookupTimeoutMs: 30000,
          },
        );
        if (result.exitCode !== 0) throw Error("GEA_COMPANY_INSTALL_FAILED: " + result.logPath);
      } catch (error) {
        if (seededLock) await rm(lockPath, { force: true });
        throw error;
      }
      await complete?.({
        writeFileAtomic,
        archiveReplacements: archives.replacements,
      });
      return result;
    },
    { waitMs: 120000 },
  );
}

async function normalizeProfileEncoding(root, home) {
  const profile = join(home, "profiles/desktop");
  const path = join(profile, "package.json");
  const original = await readFile(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!original || !original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
    return { changed: false };
  const normalized = original.subarray(3);
  const parsed = JSON.parse(normalized.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error("GEA_PROFILE_MANIFEST_INVALID");
  const require = createRequire(join(root, "dsh/package.json"));
  const { withFileLock, writeFileAtomic } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-atomic-write"))
  );
  const directory = join(profile, "gea/bootstrap/profile-encoding");
  for (const candidate of [
    home,
    join(home, "profiles"),
    profile,
    join(profile, "gea"),
    join(profile, "gea/bootstrap"),
    directory,
    path,
  ]) {
    const entry = await lstat(candidate).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      entry &&
      (entry.isSymbolicLink() || (candidate === path ? !entry.isFile() : !entry.isDirectory()))
    )
      throw Error("GEA_PROFILE_ENCODING_UNSAFE_PATH");
  }
  return withFileLock(
    path,
    async () => {
      await assertCompletedInstallation(join(profile, "gea/bootstrap"), profile);
      await assertCompletedGeaRefresh(profile);
      await assertProfileIdle(profile);
      if (!(await readFile(path)).equals(original)) throw Error("GEA_REFRESH_PROFILE_CHANGED");
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink())
        throw Error("GEA_PROFILE_ENCODING_UNSAFE_PATH");
      const backup = join(directory, "before-" + digest(original) + ".json");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const saved = await lstat(backup).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (
        saved &&
        (!saved.isFile() || saved.isSymbolicLink() || !(await readFile(backup)).equals(original))
      )
        throw Error("GEA_PROFILE_ENCODING_BACKUP_CHANGED");
      if (!saved) await writeFile(backup, original, { flag: "wx", mode: 0o600 });
      await writeFileAtomic(path, normalized, { mode: entry.mode & 0o777 });
      return { changed: true, backup };
    },
    { waitMs: 120000 },
  );
}

export async function bootstrapCompanyProfile({ root, support, seed, home }) {
  const profile = join(home, "profiles/desktop");
  const record = join(profile, "gea/bootstrap");
  const receipt = await assertCompletedInstallation(record, profile);
  const encoding = await normalizeProfileEncoding(root, home);
  const current = existsSync(join(profile, "package.json"))
    ? await json(join(profile, "package.json"))
    : undefined;
  let missing = names
    .slice(0, 3)
    .filter(
      (name) =>
        !current?.dependencies?.[name] &&
        (name !== "@changfenhuang/dsh-genui" || receipt?.status !== "installed"),
    );
  if (!missing.length && receipt?.status !== "failed")
    return { status: "existing-profile-preserved", ...encoding };
  const manifest = await readCompanySeed(seed);
  const core = await verifyCompanyCore(root, manifest.core);
  await mkdir(record, { recursive: true, mode: 0o700 });
  const requireLock = createRequire(join(root, "dsh/package.json"));
  const { withFileLock } = await import(
    pathToFileURL(requireLock.resolve("@deepseek-ai/dsh-atomic-write"))
  );
  return withFileLock(
    join(record, "installation"),
    async () => {
      const latestReceipt = await assertCompletedInstallation(record, profile);
      const latest = existsSync(join(profile, "package.json"))
        ? await json(join(profile, "package.json"))
        : undefined;
      missing = manifest.packages
        .map((row) => row.name)
        .filter(
          (name) =>
            !latest?.dependencies?.[name] &&
            (name !== "@changfenhuang/dsh-genui" || latestReceipt?.status !== "installed"),
        );
      if (!missing.length) {
        if (latestReceipt?.status === "failed") throw Error("GEA_COMPANY_INSTALL_INCOMPLETE");
        return { status: "existing-profile-preserved", changed: false };
      }
      for (const file of [
        "package.json",
        "cordis.patch.yml",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
      ]) {
        if (existsSync(join(profile, file)) && !existsSync(join(record, "before-" + file)))
          await cp(join(profile, file), join(record, "before-" + file), {
            errorOnExist: true,
            force: false,
          });
      }
      const store = join(
        home,
        "desktop-company-cache",
        digest(Buffer.from(JSON.stringify(manifest.packages))),
        "store",
      );
      if (!existsSync(store))
        await cp(join(seed, "store"), store, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      const metadata = join(home, "desktop-company-cache/metadata");
      if (!existsSync(metadata))
        await cp(join(seed, "metadata"), metadata, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      let operationStarted = false;
      try {
        const selected = manifest.packages.filter((row) => missing.includes(row.name));
        await installCompanyPackages({
          root,
          support,
          seed,
          home,
          profile,
          packages: selected.map((row) => join(seed, "archives", row.file)),
          store,
          offline: true,
          beforeInstall: async () => {
            const rejected = await assertCompletedInstallation(record, profile);
            if (rejected)
              await cp(
                join(record, "receipt.json"),
                join(record, "before-store-conflict-retry.json"),
                { force: false, errorOnExist: true },
              );
            await writeFile(
              join(record, "receipt.json"),
              JSON.stringify({ status: "installing", packages: missing }) + "\n",
              { mode: 0o600 },
            );
            operationStarted = true;
          },
          complete: async ({ writeFileAtomic }) => {
            const installed = await json(join(profile, "package.json"));
            for (const row of selected) {
              const actual = await json(join(profile, "node_modules", row.name, "package.json"));
              if (
                actual.version !== row.version ||
                !installed.dsh?.profile?.bundles?.includes(row.name)
              )
                throw Error("GEA_COMPANY_ACTIVATION_INCOMPLETE");
            }
            if (missing.includes("@cleverc2200/gea-dsh-prototype")) {
              const require = createRequire(join(root, "dsh/package.json"));
              const YAML = require("yaml");
              const patch = join(profile, "cordis.patch.yml");
              const document = YAML.parseDocument(await readFile(patch, "utf8"));
              if (document.errors.length || !Array.isArray(document.toJS()))
                throw Error("GEA_PROFILE_PATCH_INVALID");
              const rows = document.toJS();
              const index = rows.findIndex(
                (row) => row?.id === "gea-proof" || row?.name === "@cleverc2200/gea-dsh-prototype",
              );
              if (index === -1)
                document.add({
                  id: "gea-proof",
                  config: {
                    pluginUpdates: {
                      source: manifest.source,
                      checkTimeoutMs: 60000,
                      pollIntervalMs: 2000,
                      core,
                    },
                  },
                });
              else if (!rows[index].config?.pluginUpdates)
                document.setIn([index, "config", "pluginUpdates"], {
                  source: manifest.source,
                  checkTimeoutMs: 60000,
                  pollIntervalMs: 2000,
                  core,
                });
              await writeFileAtomic(patch, document.toString(), {
                mode: 0o600,
              });
            }
          },
        });
        const result = {
          status: "installed",
          changed: true,
          packages: selected.map(({ name, version }) => ({ name, version })),
        };
        await writeFile(join(record, "receipt.json"), JSON.stringify(result, null, 2) + "\n", {
          mode: 0o600,
        });
        return result;
      } catch (error) {
        if (operationStarted)
          await writeFile(
            join(record, "receipt.json"),
            JSON.stringify({ status: "failed", diagnostic: error.message }) + "\n",
            { mode: 0o600 },
          );
        throw error;
      }
    },
    { waitMs: 120000 },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, support, seed, legacyData] = process.argv.slice(2);
  const require = createRequire(join(root, "dsh/package.json"));
  const { resolveDshHome } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-home-paths"))
  );
  const home = resolveDshHome();
  await bootstrapCompanyProfile({
    root,
    support,
    seed,
    home,
  });
  await refreshCompanyCore({ root, seed, home });
  const manifest = await readCompanySeed(seed);
  console.log(
    "GEA_BUNDLED_REFRESH",
    JSON.stringify(
      await refreshBundledGea({
        root,
        support,
        seed,
        home,
        manifest,
        install: installCompanyPackages,
      }),
    ),
  );
  if (legacyData)
    console.log(
      "GEA_LEGACY_CLEANUP",
      JSON.stringify(
        await cleanupLegacyGea({
          data: legacyData,
          home,
          apply: true,
        }),
      ),
    );
}
