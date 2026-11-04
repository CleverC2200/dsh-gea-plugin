import { mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { join, isAbsolute, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { companyPackageNames, companyReleaseIndex } from "./company-archives.mjs";

const gea = "@cleverc2200/gea-dsh-prototype";
const files = ["package.json", "cordis.patch.yml", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
const optional = async (path) => {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const release = (value) => (/^0\.0\.(0|[1-9]\d*)$/.test(value) ? Number(value.split(".")[2]) : NaN);

export function planBundledCompanyRefresh(current, installed, bundled) {
  if (
    !Array.isArray(bundled) ||
    bundled.length !== companyPackageNames.length ||
    !companyPackageNames.every((name) => bundled.filter((row) => row.name === name).length === 1)
  )
    throw Error("GEA_BUNDLED_COMPANY_SUITE_REQUIRED");
  const targets = [];
  for (const row of bundled) {
    const actual = installed.find((item) => item.name === row.name);
    const spec = current?.dependencies?.[row.name];
    if (!actual || !spec) return { status: "unrecognized-company-profile", changed: false };
    if (!current.dsh?.profile?.bundles?.includes(row.name))
      return { status: "disabled-company-profile-preserved", changed: false };
    try {
      if (typeof spec !== "string" || (!/^file:.+\.tgz$/.test(spec) && spec !== actual.version))
        throw Error("CUSTOM_COMPANY_SOURCE");
      const from = companyReleaseIndex(row.name, actual.version);
      const to = companyReleaseIndex(row.name, row.version);
      if (from > to) return { status: "newer-company-suite-preserved", changed: false };
      targets.push({
        name: row.name,
        from: actual.version,
        to: row.version,
        file: row.file,
      });
    } catch {
      return { status: "custom-company-profile-preserved", changed: false };
    }
  }
  const legacy = Object.entries(current.dependencies).some(
    ([name, spec]) =>
      [...companyPackageNames, "@changfenhuang/dsh-genui"].includes(name) &&
      typeof spec === "string" &&
      spec.startsWith("file:") &&
      spec.replaceAll("\\", "/").includes("/company-seed/archives/") &&
      spec.endsWith(".tgz"),
  );
  if (!legacy && targets.every((row) => row.from === row.to))
    return { status: "current-company-suite-preserved", changed: false };
  const identity = targets.find((row) => row.name === gea);
  return {
    status: "ready",
    changed: false,
    from: identity.from,
    to: identity.to,
    targets,
  };
}

async function stoppedUpdateProcesses(profile, receipt) {
  const processes = receipt.processes;
  if (
    !Array.isArray(processes) ||
    processes.length === 0 ||
    !processes.every(
      (row) =>
        Number.isSafeInteger(row?.pid) &&
        row.pid > 0 &&
        row.grouped === (process.platform !== "win32") &&
        row.sawAlive === true &&
        typeof row.startIdentity === "string" &&
        row.startIdentity.length > 0,
    )
  )
    return false;
  if (process.platform === "win32") {
    const runtime = join(profile, "gea/plugin-updates");
    const operation = join(runtime, "operations", receipt.id);
    if (receipt.directory !== operation || processes.length !== 1) return false;
    try {
      for (const path of [join(profile, "gea"), runtime, join(runtime, "operations"), operation]) {
        const entry = await lstat(path);
        if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
      }
      const proofPath = join(operation, "windows-job.json");
      const entry = await lstat(proofPath);
      if (!entry.isFile() || entry.isSymbolicLink()) return false;
      const proof = JSON.parse(await readFile(proofPath));
      const [row] = processes;
      return (
        proof?.nonce === row.startIdentity &&
        proof?.pid === row.pid &&
        proof?.stage === "empty" &&
        Number.isInteger(proof?.exitCode)
      );
    } catch {
      return false;
    }
  }
  return processes.every((row) =>
    [row.pid, -row.pid].every((pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    }),
  );
}

async function readProfileUpdateState(
  profile,
  { allowExitedPackageRun = false, allowStoppedUpdate = false } = {},
) {
  const recorded = await optional(join(profile, ".plugin-manager/run.json"));
  if (recorded) {
    if (!allowExitedPackageRun) throw Error("GEA_REFRESH_PROFILE_BUSY");
    const run = JSON.parse(recorded);
    if (!Number.isSafeInteger(run.pid) || run.pid < 1 || typeof run.grouped !== "boolean")
      throw Error("GEA_REFRESH_PROFILE_BUSY");
    for (const pid of [
      run.pid,
      ...(run.grouped && process.platform !== "win32" ? [-run.pid] : []),
    ]) {
      try {
        process.kill(pid, 0);
        throw Error("GEA_REFRESH_PROFILE_BUSY");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  const latest = await optional(join(profile, "gea/plugin-updates/latest.json"));
  if (!latest) return;
  const pointer = JSON.parse(latest);
  if (typeof pointer.id !== "string" || !/^[a-f0-9-]{36}$/.test(pointer.id))
    throw Error("GEA_REFRESH_UPDATE_UNKNOWN");
  const receipt = JSON.parse(
    await readFile(join(profile, "gea/plugin-updates/operations", pointer.id, "receipt.json")),
  );
  if (receipt.id !== pointer.id) throw Error("GEA_REFRESH_UPDATE_UNKNOWN");
  if (
    allowStoppedUpdate &&
    ["installing", "verifying", "unknown"].includes(receipt.stage) &&
    (await stoppedUpdateProcesses(profile, receipt))
  )
    return receipt;
  if (!["pending-restart", "completed", "restored", "failed"].includes(receipt.stage))
    throw Error("GEA_REFRESH_UPDATE_PENDING");
  return receipt;
}

export async function assertProfileIdle(profile, options) {
  if ((await readProfileUpdateState(profile, options))?.stage === "pending-restart")
    throw Error("GEA_REFRESH_UPDATE_PENDING");
}

export async function assertCompletedGeaRefresh(profile, { allowArchiveRecovery = false } = {}) {
  const directory = join(profile, "gea/bootstrap/gea-refresh");
  const bytes = await optional(join(directory, "receipt.json"));
  if (!bytes) return;
  const prior = JSON.parse(bytes);
  if (prior.status === "completed") return;
  if (allowArchiveRecovery) {
    try {
      const prefix = "GEA_COMPANY_INSTALL_FAILED: ";
      if (
        prior.status !== "failed" ||
        !Number.isFinite(release(prior.from)) ||
        !Number.isFinite(release(prior.to)) ||
        typeof prior.diagnostic !== "string" ||
        !prior.diagnostic.startsWith(prefix)
      )
        throw Error("NOT_RECOVERABLE");
      const backup = prior.backup ?? join(directory, "before-" + prior.from + "-to-" + prior.to);
      const localBackup = relative(directory, backup).split(/[\\/]/);
      if (localBackup.length !== 1 || !/^before-[a-zA-Z0-9.-]+$/.test(localBackup[0]))
        throw Error("UNSAFE_BACKUP");
      if (await optional(join(backup, "failed-receipt.json"))) throw Error("ALREADY_RETRIED");
      for (const path of [
        join(profile, "gea"),
        join(profile, "gea/bootstrap"),
        directory,
        backup,
      ]) {
        const entry = await lstat(path);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error("UNSAFE_BACKUP");
      }
      for (const file of files) {
        const current = await optional(join(profile, file));
        const saved = await optional(join(backup, file));
        if (
          (current === null) !== (saved === null) ||
          (current && !current.equals(saved)) ||
          (file === "package.json" && !saved)
        )
          throw Error("PROFILE_CHANGED");
        if (saved) {
          const entry = await lstat(join(backup, file));
          if (!entry.isFile() || entry.isSymbolicLink()) throw Error("UNSAFE_BACKUP");
        }
      }
      const current = JSON.parse(await readFile(join(profile, "package.json")));
      const installed = JSON.parse(
        await readFile(join(profile, "node_modules", gea, "package.json")),
      );
      if (installed.name !== gea || installed.version !== prior.from)
        throw Error("INSTALLED_CHANGED");
      const log = prior.diagnostic.slice(prefix.length);
      const local = relative(join(profile, ".plugin-manager/logs"), log).split(/[\\/]/);
      if (
        !isAbsolute(log) ||
        local.length !== 2 ||
        !/^operation-[a-zA-Z0-9_-]+$/.test(local[0]) ||
        local[1] !== "pnpm.log"
      )
        throw Error("UNKNOWN_LOG");
      const text = await readFile(log, "utf8");
      const errors = text.split(/\r?\n/).filter((line) => /^\[[A-Z_]+\]/.test(line));
      if (errors.length !== 1) throw Error("UNKNOWN_FAILURE");
      const match = /^\[ENOENT\] ENOENT: no such file or directory, open '(.+)'$/.exec(errors[0]);
      if (
        !match ||
        ![...companyPackageNames, "@changfenhuang/dsh-genui"].some((name) => {
          const spec = current.dependencies?.[name];
          if (typeof spec !== "string" || !spec.startsWith("file:")) return false;
          const archive = spec.slice(5).replaceAll("\\", "/");
          return (
            /\/company-seed\/archives\/[^/]+\.tgz$/.test(archive) &&
            archive === match[1].replaceAll("\\", "/")
          );
        })
      )
        throw Error("UNKNOWN_FAILURE");
      return { bytes, backup };
    } catch (error) {
      throw Error("GEA_REFRESH_RECOVERY_REQUIRED", { cause: error });
    }
  }
  throw Error("GEA_REFRESH_RECOVERY_REQUIRED");
}

async function completeInterruptedUpdate({
  root,
  support,
  home,
  profile,
  install,
  receipt,
  currentBytes,
}) {
  const runtime = join(profile, "gea/plugin-updates");
  const operation = join(runtime, "operations", receipt.id);
  const journal = join(operation, "receipt.json");
  const original = await readFile(journal);
  const targets = receipt.targets;
  if (
    !isDeepStrictEqual(JSON.parse(original), receipt) ||
    receipt.schema !== 2 ||
    receipt.directory !== operation ||
    typeof receipt.processIdentity !== "string" ||
    !receipt.processIdentity ||
    !Array.isArray(receipt.logs) ||
    !receipt.logs.every((log) => typeof log === "string") ||
    !Array.isArray(targets) ||
    targets.length !== companyPackageNames.length ||
    !companyPackageNames.every(
      (name) => targets.filter((row) => row?.packageName === name).length === 1,
    ) ||
    ["packageName", "targetVersion", "targetSha256", "archivePath"].some(
      (key) => targets[0][key] !== receipt[key],
    )
  )
    throw Error("GEA_REFRESH_UPDATE_UNKNOWN");
  const current = JSON.parse(currentBytes);
  if (!companyPackageNames.every((name) => typeof current.dependencies?.[name] === "string"))
    throw Error("GEA_REFRESH_UPDATE_UNKNOWN");
  const patch = await optional(join(profile, "cordis.patch.yml"));
  await install({
    root,
    support,
    home,
    profile,
    packages: targets.map((row) => row.archivePath),
    store: join(home, "desktop-company-cache/gea-refresh/store"),
    offline: false,
    strictPeers: true,
    activateNewBundles: false,
    beforeInstall: async () => {
      const latest = await readProfileUpdateState(profile, {
        allowExitedPackageRun: true,
        allowStoppedUpdate: true,
      });
      if (
        latest?.id !== receipt.id ||
        !(await stoppedUpdateProcesses(profile, latest)) ||
        !(await readFile(journal)).equals(original) ||
        !(await readFile(join(profile, "package.json"))).equals(currentBytes)
      )
        throw Error("GEA_REFRESH_PROFILE_CHANGED");
      const cache = await realpath(join(runtime, "cache"));
      for (const target of targets) {
        if (
          typeof target.targetVersion !== "string" ||
          !target.targetVersion ||
          typeof target.targetSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(target.targetSha256) ||
          typeof target.archivePath !== "string" ||
          !isAbsolute(target.archivePath) ||
          relative(join(runtime, "cache"), target.archivePath) !== target.targetSha256 + ".tgz" ||
          (await realpath(target.archivePath)) !== join(cache, target.targetSha256 + ".tgz")
        )
          throw Error("GEA_REFRESH_UPDATE_UNKNOWN");
        const entry = await lstat(target.archivePath);
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          createHash("sha256")
            .update(await readFile(target.archivePath))
            .digest("hex") !== target.targetSha256
        )
          throw Error("GEA_REFRESH_UPDATE_UNKNOWN");
      }
    },
    complete: async ({ writeFileAtomic, result }) => {
      const after = JSON.parse(await readFile(join(profile, "package.json")));
      const expected = structuredClone(current);
      for (const target of targets) {
        const actual = JSON.parse(
          await readFile(join(profile, "node_modules", target.packageName, "package.json")),
        );
        const spec = after.dependencies?.[target.packageName];
        if (
          actual.name !== target.packageName ||
          actual.version !== target.targetVersion ||
          typeof spec !== "string" ||
          spec.replaceAll("\\", "/") !== "file:" + target.archivePath.replaceAll("\\", "/")
        )
          throw Error("GEA_REFRESH_PROFILE_NOT_PRESERVED");
        expected.dependencies[target.packageName] = spec;
      }
      if (!isDeepStrictEqual(after, expected)) throw Error("GEA_REFRESH_PROFILE_NOT_PRESERVED");
      const afterPatch = await optional(join(profile, "cordis.patch.yml"));
      if ((patch === null) !== (afterPatch === null) || (patch && !patch.equals(afterPatch)))
        throw Error("GEA_REFRESH_CONFIG_NOT_PRESERVED");
      if (!(await readFile(journal)).equals(original)) throw Error("GEA_REFRESH_PROFILE_CHANGED");
      await writeFileAtomic(
        journal,
        JSON.stringify({
          ...receipt,
          stage: "pending-restart",
          diagnostic: null,
          logs: [...receipt.logs, ...(result?.logPath ? [result.logPath] : [])],
          updatedAt: new Date().toISOString(),
        }) + "\n",
        { mode: 0o600 },
      );
    },
  });
  return { status: "pending-restart-preserved", changed: true };
}

export async function refreshBundledCompanySuite({ root, support, seed, home, manifest, install }) {
  const profile = join(home, "profiles/desktop");
  const directory = join(profile, "gea/bootstrap/gea-refresh");
  const journal = join(directory, "receipt.json");
  const currentBytes = await optional(join(profile, "package.json"));
  if (!currentBytes) return { status: "company-profile-not-installed", changed: false };
  const update = await readProfileUpdateState(profile, {
    allowExitedPackageRun: true,
    allowStoppedUpdate: true,
  });
  if (update && ["installing", "verifying", "unknown"].includes(update.stage))
    return completeInterruptedUpdate({
      root,
      support,
      home,
      profile,
      install,
      receipt: update,
      currentBytes,
    });
  const pending = update?.stage === "pending-restart";
  const preservedPending = { status: "pending-restart-preserved", changed: false };
  if (pending) {
    await assertCompletedGeaRefresh(profile);
    if (
      update.schema !== 2 ||
      !Array.isArray(update.targets) ||
      update.targets.length !== 2 ||
      !companyPackageNames
        .filter((name) => name !== gea)
        .every((name) => update.targets.filter((row) => row?.packageName === name).length === 1)
    )
      return preservedPending;
  }
  const installedFiles = new Map(
    await Promise.all(
      companyPackageNames.map(async (name) => [
        name,
        await optional(join(profile, "node_modules", name, "package.json")),
      ]),
    ),
  );
  if ([...installedFiles.values()].some((bytes) => !bytes))
    return pending ? preservedPending : { status: "company-profile-incomplete", changed: false };
  const recovery = await assertCompletedGeaRefresh(profile, {
    allowArchiveRecovery: true,
  });
  const current = JSON.parse(currentBytes);
  const installed = [...installedFiles.values()].map((bytes) => JSON.parse(bytes));
  const plan = planBundledCompanyRefresh(current, installed, manifest.packages);
  if (plan.status !== "ready") return pending ? preservedPending : plan;
  for (const name of companyPackageNames) {
    const entry = await lstat(join(profile, "node_modules", name));
    if (!entry.isDirectory() || entry.isSymbolicLink())
      return pending
        ? preservedPending
        : { status: "linked-company-profile-preserved", changed: false };
  }
  let pendingRecovery;
  if (pending) {
    if (companyReleaseIndex(gea, plan.from) >= companyReleaseIndex(gea, plan.to))
      return preservedPending;
    for (const target of update.targets) {
      const bundled = manifest.packages.find((row) => row.name === target.packageName);
      const actual = installed.find((row) => row.name === target.packageName);
      const from = companyReleaseIndex(target.packageName, target.targetVersion);
      const to = companyReleaseIndex(target.packageName, bundled.version);
      if (to < from || (to === from && bundled.sha256 !== target.targetSha256))
        return preservedPending;
      if (
        actual.version !== target.targetVersion ||
        current.dependencies[target.packageName].replaceAll("\\", "/") !==
          "file:" + String(target.archivePath).replaceAll("\\", "/")
      )
        return preservedPending;
    }
    const source = current.dependencies[gea].slice(5).replaceAll("\\", "/");
    const archiveName = "cleverc2200-gea-dsh-prototype-" + plan.from + ".tgz";
    const persistent = relative(join(home, "desktop-company-cache/archives"), source).split(
      /[\\/]/,
    );
    const cached = relative(join(profile, "gea/plugin-updates/cache"), source);
    if (
      !source.endsWith("/company-seed/archives/" + archiveName) &&
      !(
        persistent.length === 2 &&
        /^[a-f0-9]{64}$/.test(persistent[0]) &&
        persistent[1] === archiveName
      ) &&
      !/^[a-f0-9]{64}\.tgz$/.test(cached)
    )
      return preservedPending;
    const operation = join(profile, "gea/plugin-updates/operations", update.id);
    const original = await readFile(join(operation, "receipt.json"));
    if (
      update.directory !== operation ||
      !isDeepStrictEqual(JSON.parse(original), update) ||
      typeof update.processIdentity !== "string" ||
      !update.processIdentity ||
      typeof update.startedAt !== "string" ||
      typeof update.updatedAt !== "string" ||
      !(update.diagnostic === null || typeof update.diagnostic === "string") ||
      update.completionProof !== null ||
      update.completionProofs !== undefined ||
      !Array.isArray(update.logs) ||
      !update.logs.every((log) => typeof log === "string") ||
      ["packageName", "targetVersion", "targetSha256", "archivePath"].some(
        (key) => update.targets[0][key] !== update[key],
      )
    )
      throw Error("GEA_REFRESH_UPDATE_UNKNOWN");
    pendingRecovery = { operation, original };
  }
  let started = false;
  let before;
  const suffix =
    plan.from === plan.to
      ? "-" +
        createHash("sha256").update(currentBytes).update(JSON.stringify(plan.targets)).digest("hex")
      : "";
  const backup = join(directory, "before-" + plan.from + "-to-" + plan.to + suffix);
  try {
    await install({
      root,
      support,
      seed,
      home,
      profile,
      packages: plan.targets.map((row) => join(seed, "archives", row.file)),
      store: join(home, "desktop-company-cache/gea-refresh/store"),
      offline: false,
      strictPeers: true,
      ...(pendingRecovery ? { activateNewBundles: false } : {}),
      beforeInstall: async () => {
        if (pendingRecovery) {
          const latest = await readProfileUpdateState(profile, {
            allowExitedPackageRun: true,
          });
          if (
            latest?.id !== update.id ||
            latest.stage !== "pending-restart" ||
            !(await stoppedUpdateProcesses(profile, latest)) ||
            !(await readFile(join(pendingRecovery.operation, "receipt.json"))).equals(
              pendingRecovery.original,
            )
          )
            throw Error("GEA_REFRESH_UPDATE_PENDING");
          const runtime = join(profile, "gea/plugin-updates");
          for (const path of [
            runtime,
            join(runtime, "operations"),
            pendingRecovery.operation,
            join(runtime, "cache"),
          ]) {
            const entry = await lstat(path);
            if (!entry.isDirectory() || entry.isSymbolicLink())
              throw Error("GEA_REFRESH_UPDATE_UNKNOWN");
          }
          for (const target of update.targets) {
            const entry = await lstat(target.archivePath);
            if (
              !/^[a-f0-9]{64}$/.test(target.targetSha256) ||
              target.archivePath !== join(runtime, "cache", target.targetSha256 + ".tgz") ||
              !entry.isFile() ||
              entry.isSymbolicLink() ||
              createHash("sha256")
                .update(await readFile(target.archivePath))
                .digest("hex") !== target.targetSha256
            )
              throw Error("GEA_REFRESH_UPDATE_UNKNOWN");
          }
        } else await assertProfileIdle(profile);
        if (!(await readFile(join(profile, "package.json"))).equals(currentBytes))
          throw Error("GEA_REFRESH_PROFILE_CHANGED");
        for (const [name, bytes] of installedFiles)
          if (!(await readFile(join(profile, "node_modules", name, "package.json"))).equals(bytes))
            throw Error("GEA_REFRESH_PROFILE_CHANGED");
        await assertCompletedGeaRefresh(profile, {
          allowArchiveRecovery: true,
        });
        before = new Map(
          await Promise.all(files.map(async (file) => [file, await optional(join(profile, file))])),
        );
        for (const path of [
          join(profile, "gea"),
          join(profile, "gea/bootstrap"),
          directory,
          backup,
        ]) {
          const entry = await lstat(path).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
            throw Error("GEA_REFRESH_UNSAFE_BACKUP");
        }
        await mkdir(backup, { recursive: true, mode: 0o700 });
        for (const [file, bytes] of before)
          if (bytes) {
            const saved = await optional(join(backup, file));
            if (saved && !saved.equals(bytes)) throw Error("GEA_REFRESH_BACKUP_CHANGED");
            if (!saved)
              await writeFile(join(backup, file), bytes, {
                flag: "wx",
                mode: 0o600,
              });
          }
        if (recovery)
          await writeFile(join(recovery.backup, "failed-receipt.json"), recovery.bytes, {
            flag: "wx",
            mode: 0o600,
          });
        if (pendingRecovery) {
          const saved = join(backup, "pending-update-receipt.json");
          const bytes = await optional(saved);
          if (bytes) {
            const entry = await lstat(saved);
            if (
              !entry.isFile() ||
              entry.isSymbolicLink() ||
              !bytes.equals(pendingRecovery.original)
            )
              throw Error("GEA_REFRESH_BACKUP_CHANGED");
          }
          if (!bytes)
            await writeFile(saved, pendingRecovery.original, {
              flag: "wx",
              mode: 0o600,
            });
        }
        await writeFile(journal, JSON.stringify({ ...plan, status: "installing", backup }) + "\n", {
          mode: 0o600,
        });
        started = true;
      },
      complete: async ({ writeFileAtomic, archiveReplacements = [], result }) => {
        const after = JSON.parse(await readFile(join(profile, "package.json")));
        for (const target of plan.targets) {
          const actual = JSON.parse(
            await readFile(join(profile, "node_modules", target.name, "package.json")),
          );
          if (
            actual.name !== target.name ||
            actual.version !== target.to ||
            typeof after.dependencies?.[target.name] !== "string"
          )
            throw Error("GEA_REFRESH_PROFILE_NOT_PRESERVED");
        }
        const expected = structuredClone(current);
        for (const replacement of archiveReplacements) {
          if (expected.dependencies[replacement.name] !== replacement.before)
            throw Error("GEA_REFRESH_PROFILE_CHANGED");
          const installed = JSON.parse(
            await readFile(join(profile, "node_modules", replacement.name, "package.json")),
          );
          if (installed.name !== replacement.name || installed.version !== replacement.version)
            throw Error("GEA_REFRESH_PROFILE_NOT_PRESERVED");
          expected.dependencies[replacement.name] =
            "file:" + replacement.path.replaceAll("\\", "/");
        }
        const withoutCompany = (value) => {
          const copy = structuredClone(value);
          for (const name of companyPackageNames) delete copy.dependencies[name];
          return copy;
        };
        if (!isDeepStrictEqual(withoutCompany(after), withoutCompany(expected)))
          throw Error("GEA_REFRESH_PROFILE_NOT_PRESERVED");
        const patch = await optional(join(profile, "cordis.patch.yml"));
        if (
          (patch === null) !== (before.get("cordis.patch.yml") === null) ||
          (patch && !patch.equals(before.get("cordis.patch.yml")))
        )
          throw Error("GEA_REFRESH_CONFIG_NOT_PRESERVED");
        if (pendingRecovery) {
          const targets = [];
          for (const row of manifest.packages) {
            if (
              after.dependencies[row.name].replaceAll("\\", "/") !==
              "file:" +
                join(home, "desktop-company-cache/archives", row.sha256, row.file).replaceAll(
                  "\\",
                  "/",
                )
            )
              throw Error("GEA_REFRESH_PROFILE_NOT_PRESERVED");
            const bytes = await readFile(join(seed, "archives", row.file));
            if (
              !/^[a-f0-9]{64}$/.test(row.sha256) ||
              createHash("sha256").update(bytes).digest("hex") !== row.sha256
            )
              throw Error("GEA_SEED_ARCHIVE_CHANGED");
            const archivePath = join(profile, "gea/plugin-updates/cache", row.sha256 + ".tgz");
            const cached = await optional(archivePath);
            if (cached) {
              const entry = await lstat(archivePath);
              if (!entry.isFile() || entry.isSymbolicLink() || !cached.equals(bytes))
                throw Error("GEA_REFRESH_UPDATE_UNKNOWN");
            } else await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
            targets.push({
              packageName: row.name,
              targetVersion: row.version,
              targetSha256: row.sha256,
              archivePath,
            });
          }
          if (
            !(await readFile(join(pendingRecovery.operation, "receipt.json"))).equals(
              pendingRecovery.original,
            )
          )
            throw Error("GEA_REFRESH_PROFILE_CHANGED");
          await writeFileAtomic(
            join(pendingRecovery.operation, "receipt.json"),
            JSON.stringify({
              ...update,
              ...targets[0],
              targets,
              logs: [...update.logs, ...(result?.logPath ? [result.logPath] : [])],
              updatedAt: new Date().toISOString(),
            }) + "\n",
            { mode: 0o600 },
          );
        }
        await writeFileAtomic(
          journal,
          JSON.stringify({
            ...plan,
            status: "completed",
            changed: true,
            backup,
          }) + "\n",
          { mode: 0o600 },
        );
      },
    });
    return {
      ...plan,
      status: pendingRecovery ? "pending-restart-preserved" : "completed",
      changed: true,
    };
  } catch (error) {
    if (started)
      await writeFile(
        journal,
        JSON.stringify({
          ...plan,
          backup,
          status: "failed",
          diagnostic: error.message,
        }) + "\n",
        { mode: 0o600 },
      );
    throw error;
  }
}
