import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyInstallation, openCompanyInstallation } from "./company-installation.mjs";
import { companyPackageNames } from "./company-archives.mjs";
import { prepareCompanyBoot } from "./company-bootstrap.mjs";
import { companyUpdatePath, readCompanyUpdate } from "./company-update.mjs";

const core = "a".repeat(40);
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "gea installation "));
  const profile = join(home, "profiles/desktop");
  await mkdir(profile, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  const manifest = {
    dependencies: Object.fromEntries(companyPackageNames.map((name) => [name, "1.0.0"])),
    dsh: { profile: { bundles: companyPackageNames.slice(0, 2) } },
    customSetting: "retained",
  };
  await writeFile(join(profile, "package.json"), JSON.stringify(manifest));
  await writeFile(join(profile, "cordis.patch.yml"), "private user configuration");
  await writeFile(join(profile, "pnpm-lock.yaml"), "original lock");
  await mkdir(join(profile, "sessions"));
  await writeFile(join(profile, "sessions/old.jsonl"), "saved conversation");
  await writeFile(join(profile, "credentials.encrypted"), "encrypted credentials");
  for (const name of companyPackageNames) {
    await mkdir(join(profile, "node_modules", name), { recursive: true });
    await writeFile(
      join(profile, "node_modules", name, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        exports: { ".": "./host.mjs", "./client": "./client.mjs" },
      }),
    );
  }
  for (const name of companyPackageNames) {
    await writeFile(join(profile, "node_modules", name, "host.mjs"), "export function apply() {}");
    await writeFile(
      join(profile, "node_modules", name, "client.mjs"),
      "export function apply() {}",
    );
  }
  const installation = new CompanyInstallation(profile, core);
  await installation.initialize();
  const boot = await installation.beginBoot();
  const proofs = async () =>
    Promise.all(
      companyPackageNames.map(async (name) => {
        const resolvedDir = join((await installation.store.selected()).path, "node_modules", name);
        const { version } = JSON.parse(await readFile(join(resolvedDir, "package.json")));
        return {
          name,
          resolvedDir,
          host: { kind: "active", stamp: { name, version } },
          client: { kind: "observed", stamp: { name, version } },
        };
      }),
    );
  assert.equal(await installation.confirmRuntime(await proofs()), true);
  const preserved = async () => {
    assert.equal(await readFile(join(profile, "sessions/old.jsonl"), "utf8"), "saved conversation");
    assert.equal(
      await readFile(join(profile, "credentials.encrypted"), "utf8"),
      "encrypted credentials",
    );
    assert.equal(
      await readFile(join(profile, "cordis.patch.yml"), "utf8"),
      "private user configuration",
    );
    assert.deepEqual(JSON.parse(await readFile(join(profile, "package.json"))).dsh, manifest.dsh);
  };
  const update = async (stage) => {
    const next = JSON.parse(await readFile(join(stage, "package.json")));
    for (const name of companyPackageNames) {
      next.dependencies[name] = "2.0.0";
      await writeFile(
        join(stage, "node_modules", name, "package.json"),
        JSON.stringify({
          name,
          version: "2.0.0",
          exports: { ".": "./host.mjs", "./client": "./client.mjs" },
        }),
      );
    }
    await writeFile(join(stage, "package.json"), JSON.stringify(next));
    await writeFile(join(stage, "pnpm-lock.yaml"), "new lock");
  };
  return { home, profile, installation, boot, proofs, preserved, update };
}

test("company preparation leaves the running graph untouched and activation keeps the original user profile", async (t) => {
  const f = await fixture(t);
  await f.installation.prepare("new-version", f.update);
  assert.equal(
    JSON.parse(
      await readFile(join(f.profile, "node_modules", companyPackageNames[0], "package.json")),
    ).version,
    "1.0.0",
  );
  await assert.rejects(readFile(join(f.installation.store.baseline, "sessions/old.jsonl")), {
    code: "ENOENT",
  });
  assert.equal((await f.installation.beginBoot()).id, "new-version");
  assert.equal(
    JSON.parse(
      await readFile(join(f.profile, "node_modules", companyPackageNames[0], "package.json")),
    ).version,
    "2.0.0",
  );
  assert.equal(await f.installation.confirmRuntime(await f.proofs()), true);
  assert.equal((await openCompanyInstallation(f.profile)).coreHead, core);
  assert.equal((await f.installation.beginBoot()).id, "new-version");
  await f.preserved();
});

test("failed installation and an interrupted trial both retain a complete usable verified graph", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.installation.prepare("broken", async (stage) => {
      await f.update(stage);
      throw Error("INSTALL_FAILED");
    }),
    /INSTALL_FAILED/,
  );
  assert.equal((await f.installation.beginBoot()).id, "baseline");
  await f.installation.confirmRuntime(await f.proofs());
  assert.ok((await readdir(f.installation.store.root)).some((name) => name.startsWith("staging-")));
  await f.installation.prepare("bad-boot", f.update);
  assert.equal((await f.installation.beginBoot()).id, "bad-boot");
  assert.equal((await f.installation.beginBoot()).id, "baseline");
  assert.equal(
    JSON.parse(
      await readFile(join(f.profile, "node_modules", companyPackageNames[0], "package.json")),
    ).version,
    "1.0.0",
  );
  await f.preserved();
});

test("a candidate writer cannot prevent startup of the separate verified graph", async (t) => {
  const f = await fixture(t);
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const preparation = f.installation.prepare("slow", async (stage, { registerProcess }) => {
    await registerProcess(process.pid);
    started();
    await waiting;
    await f.update(stage);
  });
  try {
    await ready;
    assert.equal((await f.installation.beginBoot()).id, "baseline");
    await f.preserved();
  } finally {
    release();
    await preparation;
  }
});

test("preparation takeover retains the active owner and recovery evidence", async (t) => {
  const f = await fixture(t);
  const store = f.installation.store;
  const path = join(store.root, "prepare.lock");
  await writeFile(path, "{}");
  assert.equal(await store.recoverPreparation(), "busy");
  await assert.rejects(f.installation.prepare("opaque", f.update), /PLUGIN_UPDATE_BUSY/);
  assert.equal(await readFile(path, "utf8"), "{}");
  assert.equal((await f.installation.beginBoot()).id, "baseline");
  const pid = execFileSync(process.execPath, ["-p", "process.pid"], {
    encoding: "utf8",
  }).trim();
  const abandoned = { pid: Number(pid), token: randomUUID(), purpose: "write" };
  await writeFile(path, JSON.stringify(abandoned));
  const deletionReached = Promise.withResolvers();
  let waiting = false;
  const resume = Promise.withResolvers();
  const originalRemove = fs.rm;
  fs.rm = async (file, ...args) => {
    if (file === path && !waiting) {
      waiting = true;
      deletionReached.resolve();
      await resume.promise;
    }
    return originalRemove(file, ...args);
  };
  syncBuiltinESMExports();
  const first = store.recoverPreparation();
  try {
    await Promise.race([deletionReached.promise, first]);
    assert.ok(waiting);
    assert.equal(await store.recoverPreparation(), "busy");
    assert.deepEqual(JSON.parse(await readFile(path)), abandoned);
  } finally {
    resume.resolve();
    fs.rm = originalRemove;
    syncBuiltinESMExports();
    await first;
  }
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await f.preserved();
});

test("a process assigned the old owner's PID cannot keep an abandoned legacy lock", async (t) => {
  const f = await fixture(t);
  const store = f.installation.store;
  const path = join(store.root, "prepare.lock");
  const lock = { pid: process.pid, token: randomUUID(), purpose: "write" };
  await writeFile(path, JSON.stringify(lock));
  assert.equal(await store.recoverPreparation(), "busy");
  const original = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await utimes(path, original, original);
  await f.installation.prepare("recover-reused-pid", f.update);
  assert.equal((await f.installation.beginBoot()).id, "recover-reused-pid");
  await f.preserved();
});

test("activation preserves a dependency change made after preparation", async (t) => {
  const f = await fixture(t);
  await f.installation.prepare("stale", f.update);
  const current = JSON.parse(await readFile(join(f.profile, "package.json")));
  current.dependencies["user-plugin"] = "3.0.0";
  await writeFile(join(f.profile, "package.json"), JSON.stringify(current));
  assert.equal((await f.installation.beginBoot()).id, "baseline");
  assert.equal(
    JSON.parse(await readFile(join(f.profile, "package.json"))).dependencies["user-plugin"],
    "3.0.0",
  );
  await f.preserved();
});

test("rollback retains installation edits made during an unconfirmed trial in recovery materials", async (t) => {
  const f = await fixture(t);
  await f.installation.prepare("trial-with-edit", f.update);
  await f.installation.beginBoot();
  const current = JSON.parse(await readFile(join(f.profile, "package.json")));
  current.dependencies["user-plugin"] = "3.0.0";
  const bytes = JSON.stringify(current);
  await writeFile(join(f.profile, "package.json"), bytes);
  await f.installation.rollback("GEA_TRIAL_STARTUP_TIMEOUT");
  assert.equal((await f.installation.beginBoot()).id, "baseline");
  const recoveries = (await readdir(f.installation.directory)).filter((name) =>
    name.startsWith("mount-before-"),
  );
  assert(
    (
      await Promise.all(
        recoveries.map((name) =>
          readFile(join(f.installation.directory, name, "package.json"), "utf8"),
        ),
      )
    ).includes(bytes),
  );
  await f.preserved();
});

test("boot rollback also fails a combined update receipt and preserves its original bytes", async (t) => {
  const f = await fixture(t);
  const id = "12345678-1234-1234-1234-123456789abc";
  const expected = companyPackageNames.map((name, index) => ({
    name,
    version: ["0.1.2", "0.6.3-company.2", "0.0.2"][index],
  }));
  const receipt = {
    schema: 1,
    id,
    phase: "verifying",
    desktopVersion: "0.2.0-rc.2.20261117.1",
    processIdentity: "previous-host",
    targets: expected.map((row) => ({
      ...row,
      sha256: "a".repeat(64),
      supportedCores: [{ head: core, version: "0.2.0-rc.2" }],
    })),
    expected,
  };
  await mkdir(join(f.profile, "gea/plugin-updates"), { recursive: true });
  const bytes = JSON.stringify(receipt);
  await writeFile(companyUpdatePath(f.profile), bytes);
  await f.installation.prepare("desktop-" + id, f.update);
  await f.installation.beginBoot();
  assert.equal((await f.installation.rollback("GEA_TRIAL_STARTUP_TIMEOUT")).changed, true);
  assert.equal((await readCompanyUpdate(f.profile)).phase, "failed");
  const backup = (await readdir(join(f.profile, "gea/plugin-updates"))).find((file) =>
    file.startsWith("company-update.json.before-boot-failure-"),
  );
  assert.equal(await readFile(join(f.profile, "gea/plugin-updates", backup), "utf8"), bytes);
  assert.equal((await f.installation.beginBoot()).id, "baseline");
  await f.preserved();
});

for (const failure of [
  false,
  true,
  "partial",
  "interrupted-initialization",
  "interrupted-preparation",
])
  test(`the shipped bootstrap retains the previous graph across bundled preparation and trial failure (${failure})`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "gea bootstrap installation "));
    t.after(() => rm(home, { recursive: true, force: true }));
    const profile = join(home, "profiles/desktop");
    const oldVersions = ["0.1.1", "0.6.3-company.1", "0.0.1"];
    const versions = ["0.1.2", "0.6.3-company.2", "0.0.2"];
    const packages = companyPackageNames.map((name, index) => ({
      name,
      version: versions[index],
      file: `company-${index}.tgz`,
      sha256: "b".repeat(64),
    }));
    await mkdir(profile, { recursive: true });
    await writeFile(join(home, "draft.json"), "keep draft");
    const manifest = {
      dependencies: Object.fromEntries(
        companyPackageNames.map((name, index) => [name, oldVersions[index]]),
      ),
      dsh: { profile: { bundles: companyPackageNames } },
      userSetting: "keep",
    };
    await writeFile(join(profile, "package.json"), JSON.stringify(manifest));
    for (const [index, name] of companyPackageNames.entries()) {
      await mkdir(join(profile, "node_modules", name), { recursive: true });
      await writeFile(
        join(profile, "node_modules", name, "package.json"),
        JSON.stringify({
          name,
          version: oldVersions[index],
          exports: { ".": "./host.mjs", "./client": "./client.mjs" },
        }),
      );
    }
    for (const name of companyPackageNames) {
      await writeFile(
        join(profile, "node_modules", name, "host.mjs"),
        "export function apply() {}",
      );
      await writeFile(
        join(profile, "node_modules", name, "client.mjs"),
        "export function apply() {}",
      );
    }
    let calls = 0;
    let shouldFail = failure === true;
    const options = {
      home,
      root: "unused",
      support: "unused",
      seed: "unused",
      manifest: { packages, core: { head: core } },
      install: async ({ profile: candidate, beforeInstall, complete }) => {
        await beforeInstall?.();
        calls++;
        assert.notEqual(candidate, profile);
        const current = JSON.parse(await readFile(join(candidate, "package.json")));
        for (const row of packages) {
          current.dependencies[row.name] = row.version;
          await writeFile(
            join(candidate, "node_modules", row.name, "host.mjs"),
            "export function apply() {}",
          );
          await writeFile(
            join(candidate, "node_modules", row.name, "package.json"),
            JSON.stringify({
              name: row.name,
              version: row.version,
              exports: { ".": "./host.mjs", "./client": "./client.mjs" },
            }),
          );
        }
        await writeFile(join(candidate, "package.json"), JSON.stringify(current));
        if (shouldFail) throw Error("PREPARATION_INTERRUPTED");
        await complete?.({ writeFileAtomic: writeFile });
      },
    };
    if (failure === "partial")
      await rm(join(profile, "node_modules", companyPackageNames[2], "host.mjs"));
    const installation = new CompanyInstallation(profile, core);
    await mkdir(join(profile, "gea"), { recursive: true });
    await writeFile(
      join(profile, "gea/installation.json"),
      JSON.stringify({ schema: 1, coreHead: core, graphId: "baseline" }),
    );
    if (failure === "interrupted-preparation") {
      await installation.initialize();
      const id = randomUUID();
      await mkdir(join(profile, "gea/plugin-updates"), { recursive: true });
      const previous = process.env.GEA_DESKTOP_VERSION;
      process.env.GEA_DESKTOP_VERSION = "0.2.0-rc.2.20261124.1";
      t.after(() => {
        if (previous === undefined) delete process.env.GEA_DESKTOP_VERSION;
        else process.env.GEA_DESKTOP_VERSION = previous;
      });
      await writeFile(
        companyUpdatePath(profile),
        JSON.stringify({
          schema: 1,
          id,
          phase: "prepared",
          desktopVersion: process.env.GEA_DESKTOP_VERSION,
          processIdentity: "old-desktop",
          expected: null,
          targets: packages.map(({ name, version }) => ({
            name,
            version,
            sha256: "b".repeat(64),
            supportedCores: [{ head: core, version: "0.2.0-rc.2" }],
          })),
        }),
      );
    }
    if (["interrupted-initialization", "interrupted-preparation"].includes(failure)) {
      const module = new URL("./company-installation.mjs", import.meta.url).href;
      execFileSync(process.execPath, [
        "--input-type=module",
        "-e",
        `import { CompanyInstallation } from ${JSON.stringify(module)};
           const installation = new CompanyInstallation(process.argv[1], process.argv[2]);
           const interrupt = async () => process.exit(0);
           if (process.argv[3] === "interrupted-preparation")
             await installation.prepare("interrupted", interrupt);
           else await installation.initialize(interrupt);`,
        profile,
        core,
        failure,
      ]);
      const lock = join(installation.store.root, "prepare.lock");
      assert.ok(JSON.parse(await readFile(lock)).pid > 0);
      assert.equal(await readFile(join(home, "draft.json"), "utf8"), "keep draft");
    }
    const boot = await prepareCompanyBoot(options);
    if (failure === "interrupted-preparation") {
      const receipt = await readCompanyUpdate(profile);
      assert.match(boot.graphId, /^bundled-/);
      assert.equal(receipt.phase, "prepared");
      assert.equal(calls, 1);
      assert.equal(await readFile(join(home, "draft.json"), "utf8"), "keep draft");
      return;
    }
    assert.equal(boot.trial, !failure || failure === "interrupted-initialization");
    assert.equal(
      JSON.parse(
        await readFile(
          join(installation.store.baseline, "node_modules", companyPackageNames[2], "package.json"),
        ),
      ).version,
      failure === "partial" ? versions[2] : oldVersions[2],
    );
    const next = await prepareCompanyBoot(options);
    assert.equal(next.graphId, "baseline");
    assert.equal(calls, 1);
    assert.equal(
      JSON.parse(
        await readFile(join(profile, "node_modules", companyPackageNames[2], "package.json")),
      ).version,
      failure === "partial" ? versions[2] : oldVersions[2],
    );
    assert.equal(JSON.parse(await readFile(join(profile, "package.json"))).userSetting, "keep");
    assert.equal(await readFile(join(home, "draft.json"), "utf8"), "keep draft");
    if (failure !== "partial") {
      shouldFail = false;
      const retried = await prepareCompanyBoot({ ...options, retry: true });
      assert.equal(retried.trial, true);
      assert.notEqual(retried.graphId, boot.graphId);
      assert.equal(calls, 2);
      assert.equal(await readFile(join(home, "draft.json"), "utf8"), "keep draft");
    }
    await assert.rejects(readFile(join(installation.store.baseline, "draft.json")), {
      code: "ENOENT",
    });
  });

test("a baseline mounted across Core upgrades completes the new Core marker", async (t) => {
  const f = await fixture(t);
  const next = new CompanyInstallation(f.profile, "b".repeat(40));
  await next.initialize();
  await rm(join(f.profile, "node_modules"));
  await fs.symlink(
    join(next.store.baseline, "node_modules"),
    join(f.profile, "node_modules"),
    "dir",
  );
  await next.beginBoot();
  assert.equal((await openCompanyInstallation(f.profile)).coreHead, next.coreHead);
  await f.preserved();
});

test("verified mounted graph starts without updating metadata when the disk is full", async (t) => {
  const f = await fixture(t);
  await f.installation.store.beginBoot();
  const before = await readFile(join(f.installation.store.root, "selection.json"));
  const original = fs.open;
  fs.open = async (path, ...args) => {
    if (String(path).includes("selection.json.") && args[0] === "wx")
      throw Object.assign(Error("full disk"), { code: "ENOSPC" });
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const result = await prepareCompanyBoot({
      home: f.home,
      root: "unused",
      support: "unused",
      seed: "unused",
      manifest: {
        core: { head: core },
        packages: companyPackageNames.map((name) => ({ name, version: "1.0.0" })),
      },
    });
    assert.equal(result.graphId, "baseline");
    assert.equal(result.trial, false);
    assert.deepEqual(await readFile(join(f.installation.store.root, "selection.json")), before);
    await f.preserved();
  } finally {
    fs.open = original;
    syncBuiltinESMExports();
  }
});

test("metadata recovery refuses a live legacy writer on the mounted graph", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.profile, ".plugin-manager"), { recursive: true });
  await writeFile(
    join(f.profile, ".plugin-manager/run.json"),
    JSON.stringify({ pid: process.pid, grouped: false }),
  );
  await assert.rejects(
    prepareCompanyBoot({
      home: f.home,
      root: "unused",
      support: "unused",
      seed: "unused",
      manifest: { core: { head: core }, packages: [] },
    }),
    /GEA_REFRESH_PROFILE_BUSY/,
  );
  await f.preserved();
});

for (const recover of [false, true])
  test(`a new Core ignores an old accepted update and builds only its bundled graph (${recover})`, async (t) => {
    const f = await fixture(t);
    const updateId = randomUUID();
    const updates = join(f.profile, "gea/plugin-updates");
    await mkdir(join(updates, "operations", updateId), { recursive: true });
    const oldReceipt = JSON.stringify({ id: updateId, stage: "accepted", processes: [] });
    await writeFile(join(updates, "latest.json"), JSON.stringify({ id: updateId }));
    await writeFile(join(updates, "operations", updateId, "receipt.json"), oldReceipt);
    const packages = companyPackageNames.map((name, index) => ({
      name,
      version: "2.0.0",
      file: `bundled-${index}.tgz`,
    }));
    await mkdir(join(f.home, "bundled-seed/store"), { recursive: true });
    await mkdir(join(f.home, "bundled-seed/metadata"), { recursive: true });
    let installs = 0;
    const result = await prepareCompanyBoot({
      home: f.home,
      root: "unused",
      support: "unused",
      seed: join(f.home, "bundled-seed"),
      recover,
      manifest: { core: { head: "b".repeat(40) }, packages },
      install: async ({ profile, offline, packages: archives, strictPeers }) => {
        installs++;
        assert.equal(offline, true);
        assert.notEqual(strictPeers, true);
        assert.deepEqual(
          archives,
          packages.map((row) => join(f.home, "bundled-seed/archives", row.file)),
        );
        await assert.rejects(
          readFile(join(profile, "node_modules", companyPackageNames[0], "package.json")),
          { code: "ENOENT" },
        );
        const manifest = JSON.parse(await readFile(join(profile, "package.json")));
        manifest.dependencies = Object.fromEntries(packages.map((row) => [row.name, row.version]));
        await writeFile(join(profile, "package.json"), JSON.stringify(manifest));
        for (const row of packages) {
          const directory = join(profile, "node_modules", row.name);
          await mkdir(directory, { recursive: true });
          await writeFile(
            join(directory, "package.json"),
            JSON.stringify({ ...row, exports: { ".": "./host.mjs", "./client": "./client.mjs" } }),
          );
          await writeFile(join(directory, "host.mjs"), "export function apply() {}");
          await writeFile(join(directory, "client.mjs"), "export function apply() {}");
        }
      },
    });
    assert.equal(result.coreHead, "b".repeat(40));
    assert.equal(result.graphId, "baseline");
    assert.equal(installs, 1);
    assert.equal(
      await readFile(join(updates, "operations", updateId, "receipt.json"), "utf8"),
      oldReceipt,
    );
    assert.equal((await openCompanyInstallation(f.profile)).coreHead, result.coreHead);
    await f.preserved();
  });

test("bootstrap recovery starts the verified graph without activating a queued candidate", async (t) => {
  const f = await fixture(t);
  await f.installation.prepare("waiting", f.update);
  const result = await prepareCompanyBoot({
    home: f.home,
    root: "unused",
    support: "unused",
    seed: "unused",
    recover: true,
    manifest: {
      core: { head: core },
      packages: companyPackageNames.map((name) => ({ name, version: "1.0.0" })),
    },
    install: async () => assert.fail("recovery cannot prepare a new update"),
  });
  assert.equal(result.graphId, "baseline");
  assert.equal(result.trial, false);
  await f.preserved();
});

for (const broken of ["{interrupted-selection", "{}"])
  test(`a damaged selection recovers the current Core baseline and preserves the original record (${broken})`, async (t) => {
    const f = await fixture(t);
    const selection = join(f.installation.store.root, "selection.json");
    await writeFile(selection, broken);
    const result = await prepareCompanyBoot({
      home: f.home,
      root: "unused",
      support: "unused",
      seed: "unused",
      manifest: { core: { head: core }, packages: [] },
      install: async () => assert.fail("a usable baseline does not need installation"),
    });
    assert.equal(result.graphId, "baseline");
    const backups = (await readdir(f.installation.store.root)).filter((name) =>
      name.startsWith("selection.json.before-recovery-"),
    );
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(f.installation.store.root, backups[0]), "utf8"), broken);
    assert.equal((await openCompanyInstallation(f.profile)).coreHead, core);
    await f.preserved();
  });

test("a corrupt old update receipt does not hide a usable verified graph", async (t) => {
  const f = await fixture(t);
  const receipt = companyUpdatePath(f.profile);
  await mkdir(join(f.profile, "gea/plugin-updates"), { recursive: true });
  const damaged = "{old-receipt-write-interrupted";
  await writeFile(receipt, damaged);
  const result = await prepareCompanyBoot({
    home: f.home,
    root: "unused",
    support: "unused",
    seed: "unused",
    manifest: {
      core: { head: core },
      packages: companyPackageNames.map((name) => ({ name, version: "1.0.0" })),
    },
    install: async () => assert.fail("verified graph must remain usable"),
  });
  assert.equal(result.graphId, "baseline");
  assert.equal(result.trial, false);
  assert.equal(await readFile(receipt, "utf8"), damaged);
  await f.preserved();
});

test("a live legacy worker remains blocked even without a package run record", async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const updates = join(f.profile, "gea/plugin-updates");
  await mkdir(join(updates, "operations", id), { recursive: true });
  await writeFile(join(updates, "latest.json"), JSON.stringify({ id }));
  await writeFile(
    join(updates, "operations", id, "receipt.json"),
    JSON.stringify({
      id,
      stage: "accepted",
      processes: [
        {
          pid: process.pid,
          grouped: process.platform !== "win32",
          sawAlive: true,
          startIdentity: "live-legacy-worker",
        },
      ],
    }),
  );
  await assert.rejects(
    prepareCompanyBoot({
      home: f.home,
      root: "unused",
      support: "unused",
      seed: "unused",
      manifest: { core: { head: core }, packages: [] },
    }),
    /GEA_REFRESH_PROFILE_BUSY/,
  );
  await f.preserved();
});

test("an interrupted mount marker is preserved and completed on the next boot", async (t) => {
  const f = await fixture(t);
  const marker = "{interrupted-mount";
  await writeFile(join(f.profile, "gea/installation.json"), marker);
  assert.equal((await f.installation.beginBoot()).id, "baseline");
  assert.equal((await openCompanyInstallation(f.profile)).coreHead, core);
  const backups = (await readdir(f.installation.directory)).filter((name) =>
    name.startsWith("mount-before-"),
  );
  assert.ok(
    (
      await Promise.all(
        backups.map((name) =>
          readFile(join(f.installation.directory, name, "installation.json"), "utf8").catch(
            () => null,
          ),
        ),
      )
    ).includes(marker),
  );
  await f.preserved();
});
