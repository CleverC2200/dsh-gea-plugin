import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const [root, support, seed, output] = process.argv.slice(2).map((path) => resolve(path));
const { installCompanyPackages, bootstrapCompanyProfile, readCompanySeed } = await import(
  pathToFileURL(join(root, "company-bootstrap.mjs"))
);
const { refreshBundledCompanySuite } = await import(
  pathToFileURL(join(root, "company-gea-refresh.mjs"))
);
const home = join(output, "home");
const profile = join(home, "profiles/desktop");
const old = join(output, "old-client/company-seed/archives");
await mkdir(old, { recursive: true });
const identities = [
  [
    "cleverc2200-dsh-agent-workbench-0.1.9.tgz",
    "4d195000e1d92db5db4c439e4fd5c16a55da424c18f47452d6c371c9b2c567ff",
  ],
  [
    "dsh-agent-manage-0.6.3-company.16.tgz",
    "2c8c6719f708da7f4b27c6cb59843029b22356a0bdf3210a0f38dc49e16db23d",
  ],
  [
    "cleverc2200-gea-dsh-prototype-0.0.159.tgz",
    "56b4940291e08ca092fe0a7c397ebb4cb25ec9e3711cd4ea7d1aa0b785cfbf89",
  ],
  ["dsh-genui-0.11.3.tgz", "6f7de08dc584a5097e4064296dd23bbfa79a7b1af705f6b497bd99906ab1030a"],
];
const packages = [];
for (const [file, sha256] of identities) {
  const url = file.startsWith("dsh-genui")
    ? "https://registry.npmjs.org/@changfenhuang/dsh-genui/-/" + file
    : "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/plugin-release/packages/" +
      sha256 +
      "/" +
      file;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: "error" });
  assert.equal(response.ok, true, file);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, file);
  const path = join(old, file);
  await writeFile(path, bytes);
  packages.push(path);
}
await installCompanyPackages({
  root,
  support,
  home,
  profile,
  packages,
  store: join(output, "store"),
  offline: false,
});
const before = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
assert.ok(before.dsh.profile.bundles.includes("@cleverc2200/gea-dsh-prototype"));
const patch = await readFile(join(profile, "cordis.patch.yml"));
await mkdir(join(profile, "sessions"), { recursive: true });
await writeFile(join(profile, "sessions/user-data.json"), '{"keep":"user draft"}');
await rm(join(output, "old-client"), { recursive: true });
const manifest = await readCompanySeed(seed);
const options = { root, support, seed, home, manifest, install: installCompanyPackages };
await assert.rejects(
  refreshBundledCompanySuite({
    ...options,
    install: (args) => installCompanyPackages({ ...args, seed: undefined }),
  }),
  /GEA_COMPANY_INSTALL_FAILED/,
);
const journal = join(profile, "gea/bootstrap/gea-refresh/receipt.json");
const failed = JSON.parse(await readFile(journal, "utf8"));
assert.equal(failed.status, "failed");
const log = await readFile(failed.diagnostic.slice("GEA_COMPANY_INSTALL_FAILED: ".length), "utf8");
assert.match(log, /\[ENOENT\].*dsh-genui-0\.11\.3\.tgz/);
await writeFile(join(output, "failure-pnpm.log"), log);
await writeFile(join(output, "failed-receipt.json"), JSON.stringify(failed, null, 2));
const recovered = await refreshBundledCompanySuite(options);
assert.equal(recovered.status, "completed");
assert.deepEqual(
  JSON.parse(
    await readFile(
      join(
        profile,
        `gea/bootstrap/gea-refresh/before-${failed.from}-to-${failed.to}/failed-receipt.json`,
      ),
      "utf8",
    ),
  ),
  failed,
);
for (const row of manifest.packages) {
  const actual = JSON.parse(
    await readFile(join(profile, "node_modules", row.name, "package.json"), "utf8"),
  );
  assert.equal(actual.version, row.version, row.name);
}
const current = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
assert.deepEqual(current.dsh.profile.bundles, before.dsh.profile.bundles);
assert.equal(
  JSON.parse(
    await readFile(join(profile, "node_modules/@changfenhuang/dsh-genui/package.json"), "utf8"),
  ).version,
  "0.11.3",
);
for (const spec of Object.values(current.dependencies))
  assert.ok(spec.includes("desktop-company-cache/archives/"), spec);
assert.deepEqual(await readFile(join(profile, "cordis.patch.yml")), patch);
assert.equal(
  await readFile(join(profile, "sessions/user-data.json"), "utf8"),
  '{"keep":"user draft"}',
);

const moved = join(output, "same-version-client/company-seed/archives");
await mkdir(moved, { recursive: true });
const sameVersionPackages = [];
for (const spec of Object.values(current.dependencies)) {
  const source = spec.slice(5);
  const target = join(moved, source.replaceAll("\\", "/").split("/").at(-1));
  await copyFile(source, target);
  sameVersionPackages.push(target);
}
await installCompanyPackages({
  root,
  support,
  home,
  profile,
  packages: sameVersionPackages,
  store: join(output, "store"),
  offline: false,
});
await rm(join(output, "same-version-client"), { recursive: true });
const sameVersion = await refreshBundledCompanySuite(options);
assert.equal(sameVersion.status, "completed");
assert.equal(sameVersion.from, sameVersion.to);
const plain = await readFile(join(profile, "package.json"));
const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
await writeFile(join(profile, "package.json"), bom);
const normalized = await bootstrapCompanyProfile({ root, support, seed, home });
assert.equal(normalized.changed, true);
assert.deepEqual(await readFile(normalized.backup), bom);
assert.deepEqual(await readFile(join(profile, "package.json")), plain);
const restarted = spawnSync(
  process.execPath,
  ["--expose-internals", join(root, "company-bootstrap.mjs"), root, support, seed],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME: home },
    encoding: "utf8",
  },
);
await writeFile(join(output, "restart.log"), restarted.stdout + restarted.stderr);
assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
assert.equal(JSON.parse(await readFile(journal, "utf8")).status, "completed");
await writeFile(
  join(output, "result.json"),
  JSON.stringify(
    {
      status: "passed",
      platform: process.platform,
      arch: process.arch,
      scenario:
        "real published GEA159/W9/M16/GenUI0.11.3, removed old client, actual failure then recovery and actual packaged bootstrap restart after BOM conversion",
      recovered,
      normalized,
      preservedBundles: current.dsh.profile.bundles,
    },
    null,
    2,
  ),
);
console.log("Legacy company archive recovery and BOM startup passed.");
