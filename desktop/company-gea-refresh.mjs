import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
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
  if (!(release(installed.version) < release(bundled.version)))
    return { status: "current-or-custom-gea-preserved", changed: false };
  return { status: "ready", changed: false, from: installed.version, to: bundled.version };
}

async function assertIdle(profile) {
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

export async function refreshBundledGea({ root, support, seed, home, manifest, install }) {
  const profile = join(home, "profiles/desktop");
  const directory = join(profile, "gea/bootstrap/gea-refresh");
  const journal = join(directory, "receipt.json");
  const currentBytes = await optional(join(profile, "package.json"));
  const installedBytes = await optional(join(profile, "node_modules", gea, "package.json"));
  if (!currentBytes || !installedBytes) return { status: "gea-not-installed", changed: false };
  const prior = await optional(journal);
  if (prior && JSON.parse(prior).status !== "completed")
    throw Error("GEA_REFRESH_RECOVERY_REQUIRED");
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
      home,
      profile,
      packages: [join(seed, "archives", bundled.file)],
      store: join(home, "desktop-company-cache/gea-refresh/store"),
      offline: false,
      strictPeers: true,
      beforeInstall: async () => {
        await assertIdle(profile);
        if (
          !(await readFile(join(profile, "package.json"))).equals(currentBytes) ||
          !(await readFile(join(profile, "node_modules", gea, "package.json"))).equals(
            installedBytes,
          )
        )
          throw Error("GEA_REFRESH_PROFILE_CHANGED");
        const latest = await optional(journal);
        if (latest && JSON.parse(latest).status !== "completed")
          throw Error("GEA_REFRESH_RECOVERY_REQUIRED");
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
            if (!saved) await writeFile(join(backup, file), bytes, { flag: "wx", mode: 0o600 });
          }
        await writeFile(journal, JSON.stringify({ ...plan, status: "installing", backup }) + "\n", {
          mode: 0o600,
        });
        started = true;
      },
      complete: async ({ writeFileAtomic }) => {
        const after = JSON.parse(await readFile(join(profile, "package.json")));
        const actual = JSON.parse(
          await readFile(join(profile, "node_modules", gea, "package.json")),
        );
        const withoutGea = (value) => {
          const copy = structuredClone(value);
          delete copy.dependencies[gea];
          return copy;
        };
        if (
          actual.name !== gea ||
          actual.version !== bundled.version ||
          !isDeepStrictEqual(withoutGea(after), withoutGea(current))
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
        JSON.stringify({ ...plan, status: "failed", diagnostic: error.message }) + "\n",
        { mode: 0o600 },
      );
    throw error;
  }
}
