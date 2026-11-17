import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyInstallation, openCompanyInstallation } from "./company-installation.mjs";
import { companyPackageNames } from "./company-archives.mjs";

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
      JSON.stringify({ name, version: "1.0.0" }),
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
        JSON.stringify({ name, version: "2.0.0" }),
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
