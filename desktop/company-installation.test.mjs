import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyInstallation, openCompanyInstallation } from "./company-installation.mjs";
import { companyPackageNames } from "./company-archives.mjs";
import { prepareCompanyBoot } from "./company-bootstrap.mjs";
import { companyUpdatePath, readCompanyUpdate } from "./company-update.mjs";

const core = "a".repeat(40);
async function fixture(t) {
  const profile = await mkdtemp(join(tmpdir(), "gea installation "));
  t.after(() => rm(profile, { recursive: true, force: true }));
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
  return { profile, installation, boot, proofs, preserved, update };
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

for (const failure of [false, true, "partial", "interrupted-initialization"])
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
      install: async ({ profile: candidate }) => {
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
      },
    };
    if (failure === "partial")
      await rm(join(profile, "node_modules", companyPackageNames[2], "host.mjs"));
    const installation = new CompanyInstallation(profile, core);
    if (failure === "interrupted-initialization") {
      const lockModule = new URL("./plugin-store-lock.mjs", import.meta.url).href;
      const lock = join(installation.store.root, "prepare.lock");
      const child = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { withPluginStoreLock } from ${JSON.stringify(lockModule)};
           await withPluginStoreLock(process.argv[1], async () => process.exit(0));`,
          installation.store.root,
        ],
        { encoding: "utf8" },
      );
      assert.equal(child, "");
      assert.ok(JSON.parse(await readFile(lock)).pid > 0);
      assert.equal(await readFile(join(home, "draft.json"), "utf8"), "keep draft");
    }
    const boot = await prepareCompanyBoot(options);
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
