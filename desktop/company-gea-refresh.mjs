import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join, isAbsolute, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

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

export function planBundledGeaRefresh(current, installed, bundled) {
  const spec = current?.dependencies?.[gea];
  if (!spec || installed?.name !== gea || bundled?.name !== gea)
    return { status: "unrecognized-gea", changed: false };
  if (!current.dsh?.profile?.bundles?.includes(gea))
    return { status: "disabled-gea-preserved", changed: false };
  if (typeof spec !== "string" || !(/^0\.0\.\d+$/.test(spec) || /^file:.+\.tgz$/.test(spec)))
    return { status: "custom-gea-preserved", changed: false };
  const legacy = Object.entries(current.dependencies).some(
    ([name, value]) =>
      [
        gea,
        "@cleverc2200/dsh-agent-workbench",
        "dsh-agent-manage",
        "@changfenhuang/dsh-genui",
      ].includes(name) &&
      typeof value === "string" &&
      value.startsWith("file:") &&
      value.replaceAll("\\", "/").includes("/company-seed/archives/") &&
      value.endsWith(".tgz"),
  );
  if (
    !(release(installed.version) < release(bundled.version)) &&
    !(
      legacy &&
      Number.isFinite(release(installed.version)) &&
      installed.version === bundled.version
    )
  )
    return { status: "current-or-custom-gea-preserved", changed: false };
  return {
    status: "ready",
    changed: false,
    from: installed.version,
    to: bundled.version,
  };
}

export async function assertProfileIdle(profile) {
  if (await optional(join(profile, ".plugin-manager/run.json")))
    throw Error("GEA_REFRESH_PROFILE_BUSY");
  const latest = await optional(join(profile, "gea/plugin-updates/latest.json"));
  if (!latest) return;
  const pointer = JSON.parse(latest);
  if (typeof pointer.id !== "string" || !/^[a-f0-9-]{36}$/.test(pointer.id))
    throw Error("GEA_REFRESH_UPDATE_UNKNOWN");
  const receipt = JSON.parse(
    await readFile(join(profile, "gea/plugin-updates/operations", pointer.id, "receipt.json")),
  );
  if (receipt.id !== pointer.id || !["completed", "restored", "failed"].includes(receipt.stage))
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
      const backup = join(directory, "before-" + prior.from + "-to-" + prior.to);
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
        !match[1].replaceAll("\\", "/").endsWith("/company-seed/archives/dsh-genui-0.11.3.tgz") ||
        current.dependencies?.["@changfenhuang/dsh-genui"]?.slice(5).replaceAll("\\", "/") !==
          match[1].replaceAll("\\", "/")
      )
        throw Error("UNKNOWN_FAILURE");
      return { bytes, backup };
    } catch (error) {
      throw Error("GEA_REFRESH_RECOVERY_REQUIRED", { cause: error });
    }
  }
  throw Error("GEA_REFRESH_RECOVERY_REQUIRED");
}

export async function refreshBundledGea({ root, support, seed, home, manifest, install }) {
  const profile = join(home, "profiles/desktop");
  const directory = join(profile, "gea/bootstrap/gea-refresh");
  const journal = join(directory, "receipt.json");
  const currentBytes = await optional(join(profile, "package.json"));
  const installedBytes = await optional(join(profile, "node_modules", gea, "package.json"));
  if (!currentBytes || !installedBytes) return { status: "gea-not-installed", changed: false };
  const recovery = await assertCompletedGeaRefresh(profile, {
    allowArchiveRecovery: true,
  });
  const current = JSON.parse(currentBytes);
  const installed = JSON.parse(installedBytes);
  const bundled = manifest.packages.find((row) => row.name === gea);
  const plan = planBundledGeaRefresh(current, installed, bundled);
  if (plan.status !== "ready") return plan;
  const entry = await lstat(join(profile, "node_modules", gea));
  if (!entry.isDirectory() || entry.isSymbolicLink())
    return { status: "linked-gea-preserved", changed: false };
  let started = false;
  let before;
  try {
    await install({
      root,
      support,
      seed,
      home,
      profile,
      packages: [join(seed, "archives", bundled.file)],
      store: join(home, "desktop-company-cache/gea-refresh/store"),
      offline: false,
      strictPeers: true,
      beforeInstall: async () => {
        await assertProfileIdle(profile);
        if (
          !(await readFile(join(profile, "package.json"))).equals(currentBytes) ||
          !(await readFile(join(profile, "node_modules", gea, "package.json"))).equals(
            installedBytes,
          )
        )
          throw Error("GEA_REFRESH_PROFILE_CHANGED");
        await assertCompletedGeaRefresh(profile, {
          allowArchiveRecovery: true,
        });
        before = new Map(
          await Promise.all(files.map(async (file) => [file, await optional(join(profile, file))])),
        );
        const backup = join(directory, "before-" + plan.from + "-to-" + plan.to);
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
        await writeFile(journal, JSON.stringify({ ...plan, status: "installing", backup }) + "\n", {
          mode: 0o600,
        });
        started = true;
      },
      complete: async ({ writeFileAtomic, archiveReplacements = [] }) => {
        const after = JSON.parse(await readFile(join(profile, "package.json")));
        const actual = JSON.parse(
          await readFile(join(profile, "node_modules", gea, "package.json")),
        );
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
        const withoutGea = (value) => {
          const copy = structuredClone(value);
          delete copy.dependencies[gea];
          return copy;
        };
        if (
          actual.name !== gea ||
          actual.version !== bundled.version ||
          !isDeepStrictEqual(withoutGea(after), withoutGea(expected))
        )
          throw Error("GEA_REFRESH_PROFILE_NOT_PRESERVED");
        const patch = await optional(join(profile, "cordis.patch.yml"));
        if (
          (patch === null) !== (before.get("cordis.patch.yml") === null) ||
          (patch && !patch.equals(before.get("cordis.patch.yml")))
        )
          throw Error("GEA_REFRESH_CONFIG_NOT_PRESERVED");
        await writeFileAtomic(
          journal,
          JSON.stringify({ ...plan, status: "completed", changed: true }) + "\n",
          { mode: 0o600 },
        );
      },
    });
    return { ...plan, status: "completed", changed: true };
  } catch (error) {
    if (started)
      await writeFile(
        journal,
        JSON.stringify({
          ...plan,
          status: "failed",
          diagnostic: error.message,
        }) + "\n",
        { mode: 0o600 },
      );
    throw error;
  }
}
