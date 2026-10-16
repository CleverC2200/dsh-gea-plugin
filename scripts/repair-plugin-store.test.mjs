import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as YAML from "yaml";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { refreshCompanyCore } from "../desktop/company-bootstrap.mjs";
import { repairPluginStore } from "./repair-plugin-store.mjs";
const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
if (!sdk) throw Error("GEA_PLUGIN_UPDATE_SDK required");
const atomic = await import(pathToFileURL(join(sdk, "packages/util/atomic-write/lib/index.js")));
const manager =
  process.env.GEA_REPAIR_PNPM ??
  fileURLToPath(new URL("../node_modules/pnpm/bin/pnpm.cjs", import.meta.url));
test("old updater bridge preserves local settings and receipts and selects the existing store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gea-store-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profile"),
    store = join(root, "company cache", "store", "v11");
  await mkdir(join(profile, "node_modules"), { recursive: true });
  await mkdir(store, { recursive: true });
  await writeFile(join(profile, "package.json"), '{"private":true}');
  await writeFile(join(profile, "node_modules/.modules.yaml"), JSON.stringify({ storeDir: store }));
  const original = "# keep user workspace settings\npackages: []\nstrictPeerDependencies: false\n";
  await writeFile(join(profile, "pnpm-workspace.yaml"), original);
  const options = { profile, YAML, ...atomic };
  assert.equal((await repairPluginStore(options)).status, "ready");
  assert.equal(await readFile(join(profile, "pnpm-workspace.yaml"), "utf8"), original);
  const result = await repairPluginStore({ ...options, apply: true });
  assert.equal(await readFile(result.backup, "utf8"), original);
  const config = await readFile(join(profile, "pnpm-workspace.yaml"), "utf8");
  assert.equal(YAML.parse(config).strictPeerDependencies, false);
  assert.deepEqual(YAML.parse(config).packages, []);
  const selected = execFileSync(process.execPath, [manager, "store", "path"], {
    cwd: profile,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root },
  }).trim();
  assert.equal(selected, store);
  assert.equal((await repairPluginStore({ ...options, apply: true })).status, "already-configured");
  assert.equal(await readFile(join(profile, "pnpm-workspace.yaml"), "utf8"), config);
  const id = "11111111-1111-4111-8111-111111111111";
  await mkdir(join(profile, "gea/plugin-updates/operations", id), {
    recursive: true,
  });
  await writeFile(join(profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
  const receipt = join(profile, "gea/plugin-updates/operations", id, "receipt.json");
  await writeFile(receipt, JSON.stringify({ id, stage: "unknown" }));
  await assert.rejects(repairPluginStore({ ...options, apply: true }), /UPDATE_RECOVERY_REQUIRED/);
  await writeFile(receipt, JSON.stringify({ id, stage: "restored" }));
  assert.equal((await repairPluginStore({ ...options, apply: true })).status, "already-configured");
  await mkdir(join(profile, ".plugin-manager"));
  await writeFile(join(profile, ".plugin-manager/run.json"), "{}");
  await assert.rejects(
    repairPluginStore({ ...options, apply: true }),
    /PROFILE_WRITER_UNCONFIRMED/,
  );
  assert.equal(await readFile(join(profile, "pnpm-workspace.yaml"), "utf8"), config);
});
test("an old updater without a store argument can install after the local bridge", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gea-old-update-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profile"),
    store = join(root, "company cache", "store");
  await mkdir(profile);
  for (const [directory, version] of [
    ["old", "1.0.0"],
    ["new", "1.0.1"],
  ]) {
    await mkdir(join(root, directory));
    await writeFile(
      join(root, directory, "package.json"),
      JSON.stringify({ name: "store-bridge-fixture", version }),
    );
  }
  await writeFile(
    join(profile, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { "store-bridge-fixture": "file:../old" },
    }),
  );
  const run = (args) =>
    execFileSync(process.execPath, [manager, ...args], {
      cwd: profile,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: root },
      stdio: "pipe",
    });
  run(["install", "--offline", "--ignore-scripts", "--store-dir=" + store]);
  const originalStore = YAML.parse(
    await readFile(join(profile, "node_modules/.modules.yaml"), "utf8"),
  ).storeDir;
  await repairPluginStore({ profile, YAML, ...atomic, apply: true });
  run(["add", "file:../new", "--offline", "--ignore-scripts", "--ignore-pnpmfile", "--save-exact"]);
  assert.equal(
    JSON.parse(
      await readFile(join(profile, "node_modules/store-bridge-fixture/package.json"), "utf8"),
    ).version,
    "1.0.1",
  );
  assert.equal(
    YAML.parse(await readFile(join(profile, "node_modules/.modules.yaml"), "utf8")).storeDir,
    originalStore,
  );
});

const currentCore = {
  kind: "desktop",
  root: "/Applications/GEA Desktop.app/Contents/Resources/app.asar",
  head: "639ed015397290b3745d163aafe02ffee4aa3f84",
  version: "0.2.0-rc.2",
  artifacts: [{ path: "package.json", sha256: "a".repeat(64) }],
};

test("an existing profile that only added GenUI receives its missing update source and preserves prior settings and receipts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gea-existing-update-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "app"),
    seed = join(directory, "seed"),
    home = join(directory, "home");
  const profile = join(home, "profiles/desktop"),
    bootstrap = join(profile, "gea/bootstrap");
  await mkdir(join(root, "dsh/node_modules/@deepseek-ai"), { recursive: true });
  await mkdir(seed);
  await mkdir(bootstrap, { recursive: true });
  const repository = fileURLToPath(new URL("../", import.meta.url));
  await symlink(
    await realpath(join(repository, "node_modules/yaml")),
    join(root, "dsh/node_modules/yaml"),
    "dir",
  );
  await symlink(
    await realpath(join(repository, "node_modules/@deepseek-ai/dsh-atomic-write")),
    join(root, "dsh/node_modules/@deepseek-ai/dsh-atomic-write"),
    "dir",
  );
  await writeFile(join(root, "dsh/package.json"), "{}");
  const metadata = JSON.stringify({
    version: currentCore.version,
    dshBuildCommit: currentCore.head,
    dshBuildDirty: false,
  });
  await writeFile(join(root, "package.json"), metadata);
  const core = {
    ...currentCore,
    root,
    artifacts: [
      {
        path: "package.json",
        sha256: createHash("sha256").update(metadata).digest("hex"),
      },
    ],
  };
  const source = {
    channelUrl: "https://example.test/stable.json",
    publicKey: "keep",
  };
  await writeFile(join(seed, "manifest.json"), JSON.stringify({ core, source }));
  const patch =
    "- id: gea-proof\n  disabled: false\n  config:\n    knowledge:\n      baseUrl: https://weknora.example.test\n- id: user-disabled\n  disabled: true\n";
  await writeFile(join(profile, "cordis.patch.yml"), patch);
  const receipt = JSON.stringify({
    status: "installed",
    changed: true,
    packages: [{ name: "@changfenhuang/dsh-genui", version: "0.11.3" }],
  });
  await writeFile(join(bootstrap, "receipt.json"), receipt);
  assert.equal((await refreshCompanyCore({ root, seed, home, apply: false })).status, "ready");
  assert.equal(await readFile(join(profile, "cordis.patch.yml"), "utf8"), patch);
  const result = await refreshCompanyCore({ root, seed, home });
  assert.equal(result.status, "update-source-configured");
  assert.equal(await readFile(result.backup, "utf8"), patch);
  assert.equal(await readFile(join(bootstrap, "receipt.json"), "utf8"), receipt);
  const YAML = await import("yaml");
  const rows = YAML.parse(await readFile(join(profile, "cordis.patch.yml"), "utf8"));
  assert.deepEqual(rows[0].config.knowledge, {
    baseUrl: "https://weknora.example.test",
  });
  assert.deepEqual(rows[0].config.pluginUpdates, {
    source,
    core,
    checkTimeoutMs: 60000,
    pollIntervalMs: 2000,
  });
  assert.deepEqual(rows[1], { id: "user-disabled", disabled: true });
  await writeFile(
    join(seed, "manifest.json"),
    JSON.stringify({
      core,
      source: { channelUrl: "https://example.test/other.json" },
    }),
  );
  assert.equal((await refreshCompanyCore({ root, seed, home })).changed, false);
});
