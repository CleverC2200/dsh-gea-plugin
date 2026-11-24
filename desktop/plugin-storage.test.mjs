import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  rename,
  lstat,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginStore } from "./plugin-store.mjs";
import { collectPluginStorage, pruneUnreferencedArchives } from "./plugin-storage.mjs";
import { CompanyInstallation } from "./company-installation.mjs";
import { companyPackageNames } from "./company-archives.mjs";

const id = (n) => "channel-00000000-0000-4000-8000-" + String(n).padStart(12, "0");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "user"),
    baseline = join(root, "baseline");
  await mkdir(join(baseline, "node_modules"), { recursive: true });
  await writeFile(join(baseline, "package.json"), '{"dependencies":{}}');
  await writeFile(join(baseline, "node_modules/runtime.bin"), Buffer.alloc(65536, 7));
  const store = new PluginStore({ data, baseline });
  const update = async (name) => {
    await store.prepare({ id: name, install: async () => {} });
    await store.activate(name);
    await store.beginBoot();
    await store.confirmBoot();
  };
  return { root, data, baseline, store, update };
}
async function companyFixture(
  t,
  versions = Object.fromEntries(companyPackageNames.map((name) => [name, "1.0.0"])),
) {
  const root = await mkdtemp(join(tmpdir(), "gea-company-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profile");
  await mkdir(profile);
  await writeFile(
    join(profile, "package.json"),
    JSON.stringify({
      dependencies: versions,
    }),
  );
  for (const name of companyPackageNames) {
    const directory = join(profile, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name,
        version: versions[name],
        exports: { ".": "./host.mjs", "./client": "./client.mjs" },
      }),
    );
    await writeFile(join(directory, "host.mjs"), "export function apply() {}");
    await writeFile(join(directory, "client.mjs"), "export function apply() {}");
  }
  const installation = new CompanyInstallation(profile, "a".repeat(40));
  await installation.initialize();
  const store = installation.store;
  const update = async (name) => {
    await installation.prepare(name, async () => {});
    await installation.beginBoot();
    await store.confirmBoot();
  };
  return { root, profile, installation, store, update };
}
test("verified company updates reclaim owned same-Core graphs after three updates and expose a read-only plan", async (t) => {
  const { store, update } = await companyFixture(t);
  const versions = [
    "00000000-0000-4000-8000-000000000001",
    "desktop-00000000-0000-4000-8000-000000000002",
    "bundled-" + "b".repeat(32),
  ];
  for (const version of versions) await update(version);
  const plan = await collectPluginStorage(store, { dryRun: true });
  assert.deepEqual(plan.candidates, [versions[0]]);
  assert.deepEqual(await readdir(join(store.root, "versions")), versions.slice().sort());
  assert.deepEqual((await store.collectGarbage()).removed, [versions[0]]);
  assert.deepEqual(await readdir(join(store.root, "versions")), versions.slice(1).sort());
});
test("storage inventory preserves dead locks and every directory byte", async (t) => {
  const { store, update } = await companyFixture(t);
  const versions = [
    "00000000-0000-4000-8000-000000000081",
    "00000000-0000-4000-8000-000000000082",
    "00000000-0000-4000-8000-000000000083",
  ];
  for (const version of versions) await update(version);
  await rm(join(store.root, "selection"), { recursive: true, force: true });
  const pid = Number(
    execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }).trim(),
  );
  await writeFile(
    join(store.root, "prepare.lock"),
    JSON.stringify({ pid, token: "00000000-0000-4000-8000-000000000084", purpose: "write" }),
  );
  const inventory = async () =>
    Promise.all(
      (await readdir(store.root, { recursive: true })).sort().map(async (name) => {
        const path = join(store.root, name);
        return [name, (await lstat(path)).isFile() ? await readFile(path) : null];
      }),
    );
  const before = await inventory();
  const plan = await collectPluginStorage(store, { dryRun: true });
  assert.deepEqual(plan.candidates, [versions[0]]);
  assert.deepEqual(await inventory(), before);
});

test("legacy company graphs require a matching preparation record and intact activation and lock receipts", async (t) => {
  const { profile, installation, store, update } = await companyFixture(t);
  const bundled = "bundled-" + "c".repeat(32),
    operation = "00000000-0000-4000-8000-000000000003";
  for (const version of [
    bundled,
    operation,
    "desktop-00000000-0000-4000-8000-000000000004",
    "fixed",
    "keep-previous",
    "keep-current",
  ])
    await update(version);
  for (const version of [bundled, operation, "desktop-00000000-0000-4000-8000-000000000004"]) {
    const file = join(store.root, "versions", version, "version.json"),
      receipt = JSON.parse(await readFile(file));
    delete receipt.ownership;
    await writeFile(file, JSON.stringify(receipt));
  }
  await writeFile(
    join(installation.directory, bundled + ".json"),
    JSON.stringify({ id: bundled, stage: "prepared" }),
  );
  const operationDirectory = join(profile, "gea/plugin-updates/operations", operation);
  await mkdir(operationDirectory, { recursive: true });
  await writeFile(
    join(operationDirectory, "receipt.json"),
    JSON.stringify({
      schema: 2,
      id: operation,
      installationId: operation,
      stage: "completed",
      packageName: companyPackageNames[0],
      targetVersion: "1.0.0",
      targetSha256: "d".repeat(64),
      processIdentity: "old",
      completionProof: {
        processIdentity: "new",
        host: { kind: "active", stamp: { name: companyPackageNames[0], version: "1.0.0" } },
        client: {
          kind: "observed",
          stamp: { name: companyPackageNames[0], version: "1.0.0" },
          binding: { hostProcessIdentity: "new" },
        },
      },
    }),
  );
  await writeFile(join(store.root, "versions", bundled, "pnpm-lock.yaml"), "modified");
  assert.deepEqual((await store.collectGarbage()).removed, [operation]);
  await rm(join(store.root, "versions", bundled, "pnpm-lock.yaml"));
  assert.deepEqual((await store.collectGarbage()).removed, [bundled]);
  assert.ok(
    (await readdir(join(store.root, "versions"))).includes(
      "desktop-00000000-0000-4000-8000-000000000004",
    ),
  );
});
test("legacy desktop graphs require a completed update receipt explicitly supporting the same Core", async (t) => {
  const versions = Object.fromEntries(
    companyPackageNames.map((name, index) => [name, ["0.1.1", "0.6.3-company.1", "0.0.1"][index]]),
  );
  const { profile, store, update } = await companyFixture(t, versions);
  const operation = "00000000-0000-4000-8000-000000000041",
    graph = "desktop-" + operation;
  for (const name of [graph, "previous", "current"]) await update(name);
  const path = join(store.root, "versions", graph, "version.json"),
    receipt = JSON.parse(await readFile(path));
  delete receipt.ownership;
  await writeFile(path, JSON.stringify(receipt));
  const runtime = join(profile, "gea/plugin-updates");
  await mkdir(runtime, { recursive: true });
  const archived = join(runtime, "company-update-" + operation + ".json");
  const record = {
    schema: 1,
    id: operation,
    phase: "completed",
    desktopVersion: "1.0.0",
    processIdentity: "old",
    targets: companyPackageNames.map((name) => ({
      name,
      version: versions[name],
      sha256: "d".repeat(64),
      supportedCores: [{ head: "b".repeat(40), version: "1.0.0" }],
    })),
    expected: companyPackageNames.map((name) => ({ name, version: versions[name] })),
  };
  await writeFile(archived, JSON.stringify(record));
  assert.deepEqual((await store.collectGarbage()).removed, []);
  for (const target of record.targets) target.supportedCores[0].head = "a".repeat(40);
  await writeFile(archived, JSON.stringify(record));
  assert.deepEqual((await store.collectGarbage()).removed, [graph]);
});
test("failed company preparation reclaims only stopped rebuildable materials and keeps diagnostics and unknown state", async (t) => {
  const { store, installation, update } = await companyFixture(t);
  await update("verified");
  const fail = async (id, install) => {
    await assert.rejects(
      installation.prepare(id, async (stage, controls) => {
        await install?.(stage, controls);
        throw Error("INSTALL_FAILED");
      }),
      /INSTALL_FAILED/,
    );
    return (await readdir(store.root)).filter((name) => name.startsWith("staging-")).sort();
  };
  const [stopped] = await fail("00000000-0000-4000-8000-000000000011");
  await mkdir(join(store.root, stopped, ".plugin-manager"));
  await writeFile(join(store.root, stopped, ".plugin-manager/install.log"), "failure log");
  const stages = await fail(
    "00000000-0000-4000-8000-000000000012",
    async (stage, { registerProcess }) => {
      await registerProcess(process.pid);
    },
  );
  const live = stages.find((name) => name !== stopped);
  const all = await fail("00000000-0000-4000-8000-000000000013", async (stage) => {
    await writeFile(join(stage, "user-draft"), "preserve");
  });
  const unknown = all.find((name) => name !== stopped && name !== live);
  const unknownWriters = await fail("00000000-0000-4000-8000-000000000014", async (stage) => {
    await mkdir(join(stage, ".plugin-manager"));
    await writeFile(join(stage, ".plugin-manager/run.json"), "{}");
  });
  const unknownWriter = unknownWriters.find((name) => !all.includes(name));
  const before = await readFile(join(store.root, stopped, "preparation-failure.json"), "utf8");
  const result = await store.collectGarbage();
  assert.deepEqual(result.stagingRemoved, [stopped + "/node_modules"]);
  assert.equal(
    await readFile(join(store.root, stopped, "preparation-failure.json"), "utf8"),
    before,
  );
  assert.equal(
    await readFile(join(store.root, stopped, ".plugin-manager/install.log"), "utf8"),
    "failure log",
  );
  assert.ok((await readdir(join(store.root, live))).includes("node_modules"));
  assert.ok((await readdir(join(store.root, unknown))).includes("node_modules"));
  assert.ok((await readdir(join(store.root, unknownWriter))).includes("node_modules"));
});
test("company prepared candidates publish pending before releasing the preparation lock", async (t) => {
  const { store, update } = await companyFixture(t);
  for (const version of ["older", "previous", "current"]) await update(version);
  const candidate = "00000000-0000-4000-8000-000000000021";
  await store.prepare({ id: candidate, install: async () => {}, queueActivation: true });
  assert.equal((await store.status()).pending, candidate);
  assert.ok((await collectPluginStorage(store, { dryRun: true })).retained.includes(candidate));
});
test("interrupted failed-material collection resumes only with matching Core ownership and preserved failure proof", async (t) => {
  const { store, installation, update } = await companyFixture(t);
  await update("verified");
  await assert.rejects(
    installation.prepare("00000000-0000-4000-8000-000000000051", async () => {
      throw Error("INSTALL_FAILED");
    }),
    /INSTALL_FAILED/,
  );
  const stage = (await readdir(store.root)).find((name) => name.startsWith("staging-"));
  const token = "00000000-0000-4000-8000-000000000052",
    trash = join(store.root, "trash"),
    target = join(trash, "gc-" + token),
    id = stage + "/node_modules";
  await mkdir(trash);
  await rename(join(store.root, stage, "node_modules"), target);
  const marker = { schema: 1, kind: "staging", id, token, coreHead: "b".repeat(40) };
  await writeFile(target + ".json", JSON.stringify(marker));
  assert.deepEqual((await store.collectGarbage()).stagingRemoved, []);
  marker.coreHead = "a".repeat(40);
  await writeFile(target + ".json", JSON.stringify(marker));
  assert.deepEqual((await collectPluginStorage(store, { dryRun: true })).candidates, [id]);
  assert.deepEqual((await store.collectGarbage()).stagingRemoved, [id]);
  assert.equal(
    JSON.parse(await readFile(join(store.root, stage, "preparation-failure.json"))).code,
    "INSTALL_FAILED",
  );
});
test("company maintenance preserves pinned, fixed, cross-Core, unknown, queued and rollback graphs", async (t) => {
  const { profile, store, installation, update } = await companyFixture(t);
  const names = Array.from(
    { length: 5 },
    (_, index) => "00000000-0000-4000-8000-" + String(index + 31).padStart(12, "0"),
  );
  for (const name of names) await update(name);
  for (const [name, patch] of [
    [names[0], { pinned: true }],
    [names[1], { ownership: { schema: 1, kind: "company-update", coreHead: "b".repeat(40) } }],
    [names[2], { ownership: null }],
  ]) {
    const path = join(store.root, "versions", name, "version.json");
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path)), ...patch }));
  }
  await installation.prepare("fixed", async () => {});
  await writeFile(join(profile, "user-session"), "saved session");
  const trial = "00000000-0000-4000-8000-000000000039";
  await installation.prepare(trial, async () => {});
  assert.deepEqual((await store.collectGarbage()).removed, []);
  await installation.beginBoot();
  assert.equal((await store.collectGarbage()).skipped, "boot-not-verified");
  await installation.rollback("TEST_FAILURE");
  await installation.beginBoot();
  await store.confirmBoot();
  assert.deepEqual((await store.collectGarbage()).removed, [names[3]]);
  assert.equal((await store.selected()).id, names[4]);
  assert.equal((await store.status()).previous, trial);
  assert.equal(await readFile(join(profile, "user-session"), "utf8"), "saved session");
});
test("six successful updates retain current and previous and preserve business data", async (t) => {
  const { data, store, update } = await fixture(t);
  await mkdir(join(data, "data"), { recursive: true });
  await writeFile(join(data, "data/session"), "session");
  await writeFile(join(data, "login.encrypted"), "login");
  for (let n = 1; n <= 6; n++) await update(id(n));
  assert.equal((await readdir(join(store.root, "versions"))).length, 6);
  const result = await store.collectGarbage();
  assert.equal(result.removed.length, 4);
  assert.deepEqual(await readdir(join(store.root, "versions")), [id(5), id(6)]);
  assert.equal((await store.selected()).id, id(6));
  assert.equal(await readFile(join(data, "data/session"), "utf8"), "session");
  assert.equal(await readFile(join(data, "login.encrypted"), "utf8"), "login");
});
test("pending, manual, pinned and migration references are retained", async (t) => {
  const { store, update } = await fixture(t);
  for (let n = 1; n <= 4; n++) await update(id(n));
  await store.prepare({ id: "local-keep", install: async () => {} });
  await writeFile(
    join(store.root, "update-state.json"),
    JSON.stringify({ phase: "pending", pending: id(1) }),
  );
  const file = join(store.root, "selection.json");
  const state = JSON.parse(await readFile(file));
  await writeFile(file, JSON.stringify({ ...state, upgradedFrom: { active: id(2) } }));
  await store.collectGarbage();
  assert.equal((await readdir(join(store.root, "versions"))).length, 5);
  await writeFile(
    join(store.root, "update-state.json"),
    JSON.stringify({ phase: "cancelled", pending: id(1) }),
  );
  const receipt = join(store.root, "versions", id(1), "version.json");
  await writeFile(
    receipt,
    JSON.stringify({ ...JSON.parse(await readFile(receipt)), pinned: true }),
  );
  await store.collectGarbage();
  assert.equal((await readdir(join(store.root, "versions"))).length, 5);
});
test("unconfirmed boot, malformed update state and an active writer all block collection", async (t) => {
  const { store, update } = await fixture(t);
  for (let n = 1; n <= 3; n++) await update(id(n));
  await store.beginBoot();
  assert.equal((await store.collectGarbage()).skipped, "boot-not-verified");
  await store.confirmBoot();
  await writeFile(join(store.root, "update-state.json"), "{broken");
  assert.equal((await store.collectGarbage()).skipped, "invalid-storage-state");
  await rm(join(store.root, "update-state.json"));
  await store.withLock(async () => {
    assert.equal((await store.collectGarbage()).skipped, "store-busy");
  });
  assert.equal((await readdir(join(store.root, "versions"))).length, 3);
});
test("unknown receipts, directory links and abandoned staging are not deleted", async (t) => {
  const { root, store, update } = await fixture(t);
  for (let n = 1; n <= 3; n++) await update(id(n));
  await writeFile(join(store.root, "versions", id(1), "version.json"), "{broken");
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "keep");
  await symlink(
    outside,
    join(store.root, "versions", id(4)),
    process.platform === "win32" ? "junction" : "dir",
  );
  await mkdir(join(store.root, "staging-unknown"));
  await writeFile(join(store.root, "staging-unknown/keep"), "keep");
  await store.collectGarbage();
  assert.equal((await readdir(join(store.root, "versions"))).length, 4);
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "keep");
  assert.equal(await readFile(join(store.root, "staging-unknown/keep"), "utf8"), "keep");
});
test("archive pruning retains manifest, workspace and lock references and named core archives", async (t) => {
  const { baseline } = await fixture(t);
  const archives = join(baseline, "packages");
  await mkdir(archives);
  const names = ["a", "b", "c", "d"].map((x) => x.repeat(64) + ".tgz");
  for (const name of [...names, "core.tgz"]) await writeFile(join(archives, name), "archive");
  await writeFile(
    join(baseline, "package.json"),
    JSON.stringify({ dependencies: { plugin: "file:packages/" + names[0] } }),
  );
  await writeFile(
    join(baseline, "pnpm-workspace.yaml"),
    "overrides:\n  plugin: file:packages/" + names[1],
  );
  await writeFile(
    join(baseline, "pnpm-lock.yaml"),
    "packages:\n  file:packages/" + names[2] + ": {}",
  );
  assert.deepEqual(await pruneUnreferencedArchives(baseline), [names[3]]);
  assert.deepEqual(await readdir(archives), [...names.slice(0, 3), "core.tgz"].sort());
});

test("core collection keeps references and refuses an incomplete version inventory", async (t) => {
  const { store, update } = await fixture(t);
  await update(id(1));
  const current = "a".repeat(64),
    unused = "b".repeat(64),
    unknown = "c".repeat(64);
  for (const core of [current, unused, unknown]) {
    const path = join(store.root, "cores", core);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "node_modules.asar"), "owned core");
    await writeFile(
      join(path, "core.json"),
      JSON.stringify({ schema: 1, id: core, archiveSha256: "d".repeat(64) }),
    );
  }
  const receipt = join(store.root, "versions", id(1), "version.json");
  await writeFile(
    receipt,
    JSON.stringify({ ...JSON.parse(await readFile(receipt)), coreId: current }),
  );
  await writeFile(join(store.root, "cores", unknown, "core.json"), "{broken");
  const staging = join(store.root, "staging-unknown");
  await mkdir(staging);
  assert.deepEqual((await store.collectGarbage()).coresRemoved, []);
  await rm(staging, { recursive: true });
  assert.deepEqual((await store.collectGarbage()).coresRemoved, [unused]);
  assert.deepEqual(await readdir(join(store.root, "cores")), [current, unknown]);
});
