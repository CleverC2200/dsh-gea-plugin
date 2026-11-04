import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { companyPackageNames, companyReleaseIndex } from "./company-archives.mjs";
import { planBundledCompanyRefresh, assertProfileIdle } from "./company-gea-refresh.mjs";

export const companyUpdatePath = (profile) =>
  join(profile, "gea/plugin-updates/company-update.json");
const phases = ["prepared", "installing", "verifying", "completed", "failed", "cancelled"];
export function parseCompanyUpdate(value) {
  if (
    value?.schema !== 1 ||
    !phases.includes(value.phase) ||
    typeof value.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.desktopVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.desktopVersion) ||
    typeof value.processIdentity !== "string" ||
    !value.processIdentity ||
    !Array.isArray(value.targets) ||
    value.targets.length !== 3
  )
    throw Error("GEA_COMPANY_UPDATE_RECEIPT_INVALID");
  for (const name of companyPackageNames) {
    const rows = value.targets.filter((row) => row?.name === name);
    if (rows.length !== 1) throw Error("GEA_COMPANY_UPDATE_RECEIPT_INVALID");
    const row = rows[0];
    companyReleaseIndex(name, row.version);
    if (
      !/^[a-f0-9]{64}$/.test(row.sha256) ||
      !Array.isArray(row.supportedCores) ||
      !row.supportedCores.length ||
      !row.supportedCores.every(
        (core) => /^[a-f0-9]{40}$/.test(core?.head) && typeof core.version === "string",
      )
    )
      throw Error("GEA_COMPANY_UPDATE_RECEIPT_INVALID");
  }
  if (
    value.expected !== null &&
    (!Array.isArray(value.expected) ||
      value.expected.length !== 3 ||
      !companyPackageNames.every(
        (name) =>
          value.expected.filter((row) => row?.name === name && typeof row.version === "string")
            .length === 1,
      ))
  )
    throw Error("GEA_COMPANY_UPDATE_RECEIPT_INVALID");
  if (["verifying", "completed"].includes(value.phase) && value.expected === null)
    throw Error("GEA_COMPANY_UPDATE_RECEIPT_INVALID");
  return value;
}
export async function readCompanyUpdate(profile) {
  try {
    for (const path of [join(profile, "gea"), join(profile, "gea/plugin-updates")]) {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw Error("GEA_COMPANY_UPDATE_UNSAFE_PATH");
    }
    const entry = await lstat(companyUpdatePath(profile));
    if (!entry.isFile() || entry.isSymbolicLink()) throw Error("GEA_COMPANY_UPDATE_UNSAFE_PATH");
    return parseCompanyUpdate(JSON.parse(await readFile(companyUpdatePath(profile), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export const companyUpdateActive = (receipt) =>
  receipt !== null && !["completed", "failed", "cancelled"].includes(receipt.phase);
export function companyUpdateFinished(receipt, desktopVersion, processIdentity, items) {
  return (
    receipt?.phase === "verifying" &&
    receipt.desktopVersion === desktopVersion &&
    receipt.processIdentity !== processIdentity &&
    receipt.expected.every((target) => {
      const row = items.find((item) => item.packageName === target.name);
      return (
        row &&
        row.installedVersion === target.version &&
        row.runningHostVersion === target.version &&
        row.runningClientVersion === target.version
      );
    })
  );
}
export async function applyCompanyUpdate({
  root,
  support,
  seed,
  home,
  manifest,
  install,
  desktopVersion = process.env.GEA_DESKTOP_VERSION,
}) {
  const profile = join(home, "profiles/desktop");
  const receipt = await readCompanyUpdate(profile);
  if (receipt && receipt.desktopVersion === desktopVersion && receipt.phase === "failed")
    throw Error("GEA_COMPANY_UPDATE_RECOVERY_REQUIRED");
  if (!companyUpdateActive(receipt) || receipt.desktopVersion !== desktopVersion) return null;
  if (receipt.phase === "verifying") return { status: "company-update-verifying", changed: false };
  if (receipt.phase !== "prepared") throw Error("GEA_COMPANY_UPDATE_RECOVERY_REQUIRED");
  const currentBytes = await readFile(join(profile, "package.json"));
  const current = JSON.parse(currentBytes);
  const installed = await Promise.all(
    companyPackageNames.map(async (name) =>
      JSON.parse(await readFile(join(profile, "node_modules", name, "package.json"))),
    ),
  );
  const compatible = receipt.targets.every((row) =>
    row.supportedCores.some(
      (core) => core.head === manifest.core.head && core.version === manifest.core.version,
    ),
  );
  const above = (left, right) =>
    companyPackageNames.every(
      (name) =>
        companyReleaseIndex(name, left.find((row) => row.name === name).version) >=
        companyReleaseIndex(name, right.find((row) => row.name === name).version),
    );
  for (const target of receipt.targets) {
    const bundled = manifest.packages.find((row) => row.name === target.name);
    if (target.version === bundled.version && target.sha256 !== bundled.sha256)
      throw Error("GEA_COMPANY_UPDATE_CONTENT_MISMATCH");
  }
  const useCache = compatible && above(receipt.targets, manifest.packages);
  if (compatible && !useCache && !above(manifest.packages, receipt.targets))
    throw Error("GEA_COMPANY_UPDATE_COMBINATION_UNCONFIRMED");
  const selected = companyPackageNames.map((name) =>
    (useCache ? receipt.targets : manifest.packages).find((row) => row.name === name),
  );
  const plan = planBundledCompanyRefresh(
    current,
    installed,
    selected.map((row) => ({
      ...row,
      file: row.name.replace(/^@/, "").replace("/", "-") + ".tgz",
    })),
  );
  if (!["ready", "current-company-suite-preserved"].includes(plan.status))
    throw Error("GEA_COMPANY_UPDATE_PROFILE_UNSUPPORTED");
  const runtime = join(profile, "gea/plugin-updates");
  const cached = [];
  if (useCache) {
    for (const row of selected) {
      const path = join(runtime, "cache", row.sha256 + ".tgz");
      const entry = await lstat(path);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex") !== row.sha256
      )
        throw Error("GEA_COMPANY_UPDATE_ARCHIVE_CHANGED");
      cached.push(path);
    }
  }
  let selectedSeed = seed;
  let selectedManifest = manifest;
  if (useCache) {
    selectedSeed = await mkdtemp(join(runtime, "company-seed-"));
    await mkdir(join(selectedSeed, "archives"));
    const packages = [];
    for (const [index, row] of selected.entries()) {
      const file = row.name.replace(/^@/, "").replace("/", "-") + "-" + row.version + ".tgz";
      await copyFile(cached[index], join(selectedSeed, "archives", file));
      packages.push({ name: row.name, version: row.version, sha256: row.sha256, file });
    }
    selectedManifest = { ...manifest, packages };
    await writeFile(join(selectedSeed, "manifest.json"), JSON.stringify(selectedManifest));
  }
  const before = await readFile(companyUpdatePath(profile));
  const expected = selected.map(({ name, version }) => ({ name, version }));
  const backup = join(runtime, "company-before-" + receipt.id);
  let started = false;
  try {
    await install({
      root,
      support,
      home,
      profile,
      seed: selectedSeed,
      packages: selectedManifest.packages.map((row) => join(selectedSeed, "archives", row.file)),
      store: join(home, "desktop-company-cache/gea-refresh/store"),
      offline: false,
      strictPeers: true,
      activateNewBundles: false,
      beforeInstall: async () => {
        await assertProfileIdle(profile, { allowExitedPackageRun: true });
        if (
          !(await readFile(companyUpdatePath(profile))).equals(before) ||
          !(await readFile(join(profile, "package.json"))).equals(currentBytes)
        )
          throw Error("GEA_COMPANY_UPDATE_PLAN_CHANGED");
        await mkdir(backup, { recursive: false, mode: 0o700 });
        for (const file of [
          "package.json",
          "cordis.patch.yml",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
        ]) {
          try {
            await copyFile(join(profile, file), join(backup, file));
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        await writeFile(
          companyUpdatePath(profile),
          JSON.stringify({ ...receipt, phase: "installing" }),
        );
        started = true;
      },
      complete: async ({ writeFileAtomic, archiveReplacements = [] }) => {
        const after = JSON.parse(await readFile(join(profile, "package.json")));
        const withoutCompany = (value) => {
          const copy = structuredClone(value);
          for (const name of companyPackageNames) delete copy.dependencies[name];
          return copy;
        };
        const { isDeepStrictEqual } = await import("node:util");
        const expectedManifest = structuredClone(current);
        for (const replacement of archiveReplacements) {
          if (expectedManifest.dependencies[replacement.name] !== replacement.before)
            throw Error("GEA_COMPANY_UPDATE_CONFIG_CHANGED");
          expectedManifest.dependencies[replacement.name] =
            "file:" + replacement.path.replaceAll("\\", "/");
        }
        if (!isDeepStrictEqual(withoutCompany(expectedManifest), withoutCompany(after)))
          throw Error("GEA_COMPANY_UPDATE_CONFIG_CHANGED");
        const patch = async (base) => {
          try {
            return await readFile(join(base, "cordis.patch.yml"));
          } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
          }
        };
        const beforePatch = await patch(backup),
          afterPatch = await patch(profile);
        if (
          (beforePatch === null) !== (afterPatch === null) ||
          (beforePatch && !beforePatch.equals(afterPatch))
        )
          throw Error("GEA_COMPANY_UPDATE_CONFIG_CHANGED");
        for (const target of expected) {
          const actual = JSON.parse(
            await readFile(join(profile, "node_modules", target.name, "package.json")),
          );
          if (actual.name !== target.name || actual.version !== target.version)
            throw Error("GEA_COMPANY_UPDATE_INSTALL_UNCONFIRMED");
        }
        await writeFileAtomic(
          companyUpdatePath(profile),
          JSON.stringify({ ...receipt, phase: "verifying", expected }),
        );
      },
    });
  } catch (error) {
    if (started)
      await writeFile(
        companyUpdatePath(profile),
        JSON.stringify({ ...receipt, phase: "failed", diagnostic: error.message }),
      );
    throw error;
  }
  return { status: "company-update-verifying", changed: true };
}
