import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  applyCompanyUpdate,
  companyUpdatePath,
  readCompanyUpdate,
  companyUpdateFinished,
  parseCompanyUpdate,
} from "./company-update.mjs";
import { companyPackageNames } from "./company-archives.mjs";
import { refreshCompanyStartup } from "./company-bootstrap.mjs";
const core = { head: "a".repeat(40), version: "0.2.0-rc.2" };
const desktopVersion = "0.2.0-rc.2.20261105.1";
const versions = (n) => ["0.1." + n, "0.6.3-company." + n, "0.0." + n];
async function fixture(
  t,
  {
    bundled = 4,
    candidate = 5,
    installed = 3,
    compatible = true,
    fail = false,
    partial = false,
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "company-update-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, "profiles/desktop");
  const runtime = join(profile, "gea/plugin-updates");
  const seed = join(home, "seed");
  await mkdir(join(runtime, "cache"), { recursive: true });
  await mkdir(join(seed, "archives"), { recursive: true });
  const files = ["session.jsonl", "storage.json", "cordis.patch.yml"];
  for (const file of files) await writeFile(join(profile, file), "user-original");
  const manifest = { core, packages: [] };
  const targets = [];
  const current = {
    dependencies: { custom: "1.0.0" },
    dsh: { profile: { bundles: companyPackageNames } },
    settings: { preserve: true },
  };
  for (const [index, name] of companyPackageNames.entries()) {
    await mkdir(join(profile, "node_modules", name), { recursive: true });
    await writeFile(
      join(profile, "node_modules", name, "package.json"),
      JSON.stringify({ name, version: versions(installed)[index] }),
    );
    current.dependencies[name] = "file:/previous/" + index + ".tgz";
    const bytes = Buffer.from("cached-approved-package-" + name);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(runtime, "cache", sha256 + ".tgz"), bytes);
    const file = index + ".tgz";
    await writeFile(join(seed, "archives", file), bytes);
    manifest.packages.push({ name, version: versions(bundled)[index], file, sha256 });
    targets.push({
      name,
      version: versions(candidate)[index],
      sha256,
      supportedCores: [{ ...core, head: (compatible ? "a" : "b").repeat(40) }],
    });
  }
  await writeFile(join(seed, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(profile, "package.json"), JSON.stringify(current));
  const receipt = {
    schema: 1,
    id: "11111111-1111-4111-8111-111111111111",
    phase: "prepared",
    desktopVersion,
    processIdentity: "old-host",
    expected: null,
    targets,
  };
  await writeFile(companyUpdatePath(profile), JSON.stringify(receipt));
  let installs = 0;
  const install = async (options) => {
    installs++;
    assert.equal(options.activateNewBundles, false);
    assert.equal(options.strictPeers, true);
    await options.beforeInstall();
    const selected = JSON.parse(await readFile(join(options.seed, "manifest.json")));
    const after = structuredClone(current);
    for (const [index, row] of selected.packages.entries()) {
      if (partial && index > 0) continue;
      after.dependencies[row.name] = "file:" + options.packages[index];
      await writeFile(
        join(profile, "node_modules", row.name, "package.json"),
        JSON.stringify({ name: row.name, version: row.version }),
      );
    }
    await writeFile(join(profile, "package.json"), JSON.stringify(after));
    if (fail) throw Error("INSTALL_INTERRUPTED");
    await options.complete({ writeFileAtomic: writeFile });
  };
  const options = { root: home, support: home, seed, home, manifest, install, desktopVersion };
  return {
    profile,
    options,
    receipt,
    installs: () => installs,
    preserve: async () => {
      for (const file of files)
        assert.equal(await readFile(join(profile, file), "utf8"), "user-original");
    },
  };
}

test("client and a newer compatible cached suite are installed before Host startup, then require actual runtime agreement", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await applyCompanyUpdate({ ...f.options, desktopVersion: "0.2.0-rc.2.20261104.1" }),
    null,
  );
  assert.equal(f.installs(), 0);
  await applyCompanyUpdate(f.options);
  const receipt = await readCompanyUpdate(f.profile);
  assert.equal(receipt.phase, "verifying");
  assert.deepEqual(
    receipt.expected.map((row) => row.version),
    versions(5),
  );
  const items = receipt.expected.map((row) => ({
    packageName: row.name,
    installedVersion: row.version,
    runningHostVersion: row.version,
    runningClientVersion: row.version,
  }));
  assert.equal(companyUpdateFinished(receipt, desktopVersion, "new-host", items), true);
  assert.equal(companyUpdateFinished(receipt, desktopVersion, "old-host", items), false);
  assert.equal(companyUpdateFinished(receipt, "old-client", "new-host", items), false);
  for (const key of ["installedVersion", "runningHostVersion", "runningClientVersion"])
    assert.equal(
      companyUpdateFinished(
        receipt,
        desktopVersion,
        "new-host",
        items.map((row, index) => (index ? row : { ...row, [key]: "old-version" })),
      ),
      false,
    );
  const startup = await refreshCompanyStartup({
    ...f.options,
    legacyData: join(f.options.home, "legacy"),
  });
  assert.equal(startup.cleanup, null);
  assert.equal(f.installs(), 1);
  await f.preserve();
});

test("newer bundled suite or incompatible cached Core uses the client's complete bundled suite", async (t) => {
  for (const options of [{ bundled: 6 }, { compatible: false }]) {
    const f = await fixture(t, options);
    await applyCompanyUpdate(f.options);
    assert.deepEqual(
      (await readCompanyUpdate(f.profile)).expected.map((row) => row.version),
      versions(options.bundled ?? 4),
    );
    await f.preserve();
  }
});

test("a newer installed suite is never downgraded, and disabled profiles are preserved", async (t) => {
  const f = await fixture(t, { installed: 7 });
  await assert.rejects(applyCompanyUpdate(f.options), /PROFILE_UNSUPPORTED/);
  assert.equal(f.installs(), 0);
  const current = JSON.parse(await readFile(join(f.profile, "package.json")));
  current.dsh.profile.bundles = [];
  await writeFile(join(f.profile, "package.json"), JSON.stringify(current));
  await assert.rejects(applyCompanyUpdate(f.options), /PROFILE_UNSUPPORTED/);
});

test("changed cached bytes, cancelled consent and malformed receipts cannot install", async (t) => {
  const same = await fixture(t, { bundled: 5, candidate: 5 });
  same.receipt.targets[0].sha256 = "e".repeat(64);
  await writeFile(companyUpdatePath(same.profile), JSON.stringify(same.receipt));
  await assert.rejects(applyCompanyUpdate(same.options), /CONTENT_MISMATCH/);
  assert.equal(same.installs(), 0);
  const f = await fixture(t);
  await writeFile(
    join(f.profile, "gea/plugin-updates/cache", f.receipt.targets[0].sha256 + ".tgz"),
    "changed",
  );
  await assert.rejects(applyCompanyUpdate(f.options), /ARCHIVE_CHANGED/);
  assert.equal(f.installs(), 0);
  await writeFile(
    companyUpdatePath(f.profile),
    JSON.stringify({ ...f.receipt, phase: "cancelled" }),
  );
  assert.equal(await applyCompanyUpdate(f.options), null);
  assert.throws(() => parseCompanyUpdate({ ...f.receipt, targets: [] }), /RECEIPT_INVALID/);
});

test("interrupted or partial installation retains recovery evidence, never confirms success and does not retry automatically", async (t) => {
  for (const options of [{ fail: true }, { partial: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(applyCompanyUpdate(f.options));
    const receipt = await readCompanyUpdate(f.profile);
    assert.equal(receipt.phase, "failed");
    await assert.rejects(applyCompanyUpdate(f.options), /RECOVERY_REQUIRED/);
    assert.equal(f.installs(), 1);
    assert.ok(
      await readFile(
        join(f.profile, "gea/plugin-updates/company-before-" + receipt.id, "package.json"),
      ),
    );
    await f.preserve();
  }
});

test("ordinary startup without consent or a desktop version does not install anything", async (t) => {
  const f = await fixture(t);
  await rm(companyUpdatePath(f.profile));
  assert.equal(await applyCompanyUpdate({ ...f.options, desktopVersion: undefined }), null);
  assert.equal(f.installs(), 0);
  await f.preserve();
});
