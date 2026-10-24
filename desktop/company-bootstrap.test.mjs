import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  access,
  rm,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapCompanyProfile,
  readCompanySeed,
  planCompanyCoreRefresh,
  relocateCompanyLock,
  writeCompanySeedLock,
} from "./company-bootstrap.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

test("a relocated seed lock preserves dependency versions and rewrites peer graph paths", () => {
  const old = "file:C:\\Build (company)\\archives\\company.tgz";
  const next = "file:../../desktop-company-cache/archives/company.tgz";
  const key = "company@" + old;
  const lock = {
    importers: { ".": { dependencies: { company: { specifier: old, version: old } } } },
    packages: { [key]: { resolution: { tarball: old } }, "fast-uri@3.1.8": {} },
    snapshots: { [key + "(peer@" + old + ")"]: { dependencies: { "fast-uri": "3.1.8" } } },
  };
  const before = structuredClone(lock);
  const relocated = relocateCompanyLock(lock, [[old, next]]);
  assert.deepEqual(lock, before);
  assert.equal(relocated.packages["company@" + next].resolution.tarball, next);
  assert.deepEqual(relocated.packages["fast-uri@3.1.8"], {});
  assert.deepEqual(relocated.snapshots["company@" + next + "(peer@" + next + ")"], {
    dependencies: { "fast-uri": "3.1.8" },
  });
});

test("the bundled dependency lock is portable, integrity checked and retains the resolved closure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gea-seed-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = join(directory, "seed");
  const profile = join(directory, "profiles/desktop");
  const root = join(directory, "core");
  const yaml = join(root, "dsh/node_modules/yaml");
  for (const path of [join(seed, "archives"), profile, yaml])
    await mkdir(path, { recursive: true });
  await writeFile(join(yaml, "package.json"), '{"main":"index.cjs"}');
  await writeFile(
    join(yaml, "index.cjs"),
    "exports.parse = JSON.parse; exports.stringify = JSON.stringify;",
  );
  const packages = [];
  const dependencies = {};
  const resolutions = { "fast-uri@3.1.8": { resolution: { integrity: "keep" } } };
  for (const [index, name] of [
    "@cleverc2200/dsh-agent-workbench",
    "dsh-agent-manage",
    "@cleverc2200/gea-dsh-prototype",
  ].entries()) {
    const file = "company-" + index + ".tgz";
    const bytes = Buffer.from(name);
    await writeFile(join(seed, "archives", file), bytes);
    packages.push({
      name,
      version: "1.0.0",
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const specifier = "file:C:/Build (company)/archives/" + file;
    const version = "file:../../../seed/archives/" + file;
    dependencies[name] = { specifier, version };
    resolutions[name + "@" + version] = { resolution: { tarball: version } };
  }
  await writeFile(join(seed, "manifest.json"), JSON.stringify({ schema: 1, packages }));
  await writeFile(
    join(profile, "pnpm-lock.yaml"),
    JSON.stringify({ importers: { ".": { dependencies } }, packages: resolutions }),
  );
  await writeCompanySeedLock({ root, seed, profile });
  const manifest = await readCompanySeed(seed);
  const lock = JSON.parse(await readFile(join(seed, "dependency-lock.yaml"), "utf8"));
  assert.match(manifest.dependencyLockSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    lock.importers["."].dependencies[packages[0].name].version,
    "file:company-seed/archives/company-0.tgz",
  );
  assert.deepEqual(lock.packages["fast-uri@3.1.8"], resolutions["fast-uri@3.1.8"]);
  assert.equal(JSON.stringify(lock).includes("Build (company)"), false);
  await writeFile(join(seed, "dependency-lock.yaml"), "tampered");
  await assert.rejects(readCompanySeed(seed), /GEA_SEED_DEPENDENCY_LOCK_CHANGED/);
});

const currentCore = {
  kind: "desktop",
  root: "/Applications/GEA Desktop.app/Contents/Resources/app.asar",
  head: "639ed015397290b3745d163aafe02ffee4aa3f84",
  version: "0.2.0-rc.2",
  artifacts: [{ path: "package.json", sha256: "a".repeat(64) }],
};

test("missing update source uses the bundled source without replacing an existing source", () => {
  const source = {
    channelUrl: "https://example.test/stable.json",
    publicKey: "bundled",
  };
  assert.deepEqual(planCompanyCoreRefresh(undefined, currentCore, source), {
    source,
    core: currentCore,
    checkTimeoutMs: 60000,
    pollIntervalMs: 2000,
  });
  const existing = {
    source: { channelUrl: "https://example.test/custom.json" },
    core: currentCore,
  };
  assert.deepEqual(planCompanyCoreRefresh(existing, currentCore, source).source, existing.source);
});

test("the same admitted desktop Core refresh changes only its proof and supplies absent timing defaults", () => {
  const updates = {
    source: {
      channelUrl: "https://example.test/stable.json",
      publicKey: "keep",
    },
    checkTimeoutMs: 45000,
    pollIntervalMs: 1500,
    core: {
      ...currentCore,
      root: "/Applications/old.app/Contents/Resources/app.asar",
      artifacts: [{ path: "package.json", sha256: "b".repeat(64) }],
    },
  };
  const config = {
    pluginUpdates: updates,
    knowledge: { baseUrl: "https://weknora.example.test" },
  };
  const before = structuredClone(config);
  const next = planCompanyCoreRefresh(updates, currentCore);
  assert.deepEqual(next, { ...updates, core: currentCore });
  assert.deepEqual(config, before);
  assert.deepEqual(
    planCompanyCoreRefresh({ source: updates.source, core: updates.core }, currentCore),
    {
      source: updates.source,
      core: currentCore,
      checkTimeoutMs: 60000,
      pollIntervalMs: 2000,
    },
  );
  assert.equal(planCompanyCoreRefresh(undefined, currentCore), undefined);
});

test("a different or unknown Core proof and invalid configured timing cannot be refreshed", () => {
  for (const changed of [
    { core: { ...currentCore, head: "b".repeat(40) } },
    { core: { ...currentCore, version: "0.2.1-alpha.1" } },
    { core: { ...currentCore, kind: "source" } },
    { core: { ...currentCore, unrecognizedAdmission: true } },
    { core: { ...currentCore, artifacts: [] } },
    {
      core: {
        ...currentCore,
        artifacts: [{ path: "other.js", sha256: "b".repeat(64) }],
      },
    },
    { core: undefined },
    { checkTimeoutMs: 999 },
    { pollIntervalMs: 30001 },
  ]) {
    const updates = {
      source: { channelUrl: "keep" },
      core: currentCore,
      ...changed,
    };
    const before = structuredClone(updates);
    assert.throws(() => planCompanyCoreRefresh(updates, currentCore), /GEA_CORE_REFRESH_REJECTED/);
    assert.deepEqual(updates, before);
  }
  assert.throws(
    () => planCompanyCoreRefresh({ core: currentCore }, { ...currentCore, head: "b".repeat(40) }),
    /GEA_CORE_REFRESH_REJECTED/,
  );
});

test("an existing company profile retains configuration, disabled bundles, WeKnora and update receipts byte for byte", async () => {
  const home = await mkdtemp(join(tmpdir(), "gea-bootstrap-existing-"));
  const profile = join(home, "profiles/desktop");
  await mkdir(join(profile, "gea/plugin-updates/operations/old"), {
    recursive: true,
  });
  const files = {
    "package.json": JSON.stringify({
      dependencies: {
        "@cleverc2200/dsh-agent-workbench": "keep",
        "dsh-agent-manage": "keep",
        "@cleverc2200/gea-dsh-prototype": "keep",
        "@changfenhuang/dsh-genui": "keep",
        "user-created-example": "file:./user-created-example.tgz",
      },
      dsh: { profile: { bundles: ["user-choice"] } },
    }),
    "cordis.patch.yml":
      "- id: gea-proof\n  config:\n    knowledge:\n      baseUrl: https://weknora.example.test\n",
    "gea/plugin-updates/latest.json": '{"id":"old","stage":"completed"}',
    "gea/plugin-updates/operations/old/receipt.json": '{"version":"0.0.154","stage":"completed"}',
    "pnpm-lock.yaml": "user-owned dependency lock\n",
    "user-created-example.tgz": "user-owned plugin archive",
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(profile, name), text);
  const result = await bootstrapCompanyProfile({
    root: "unused",
    support: "unused",
    seed: "unused",
    home,
  });
  assert.deepEqual(result, {
    status: "existing-profile-preserved",
    changed: false,
  });
  for (const [name, text] of Object.entries(files))
    assert.equal(await readFile(join(profile, name), "utf8"), text);
});

test("an existing profile does not reinstall the uninstalled optional GenUI plugin", async () => {
  const home = await mkdtemp(join(tmpdir(), "gea-bootstrap-genui-uninstalled-"));
  const profile = join(home, "profiles/desktop");
  await mkdir(join(profile, "gea/bootstrap"), { recursive: true });
  await writeFile(
    join(profile, "gea/bootstrap/receipt.json"),
    JSON.stringify({ status: "installed" }),
  );
  const manifest = JSON.stringify({
    dependencies: {
      "@cleverc2200/dsh-agent-workbench": "keep",
      "dsh-agent-manage": "keep",
      "@cleverc2200/gea-dsh-prototype": "keep",
    },
  });
  await writeFile(join(profile, "package.json"), manifest);
  assert.deepEqual(
    await bootstrapCompanyProfile({
      root: "unused",
      support: "unused",
      seed: "unused",
      home,
    }),
    { status: "existing-profile-preserved", changed: false },
  );
  assert.equal(await readFile(join(profile, "package.json"), "utf8"), manifest);
});

test("an incomplete owned installation cannot be hidden by four declared dependencies", async () => {
  for (const receipt of [
    '{"status":"installing","packages":["dsh-agent-manage"]}',
    '{"status":"failed","diagnostic":"configuration write failed"}',
    '{"status":"unknown"}',
    "{incomplete",
  ]) {
    const home = await mkdtemp(join(tmpdir(), "gea-bootstrap-incomplete-"));
    const profile = join(home, "profiles/desktop");
    const record = join(profile, "gea/bootstrap/receipt.json");
    await mkdir(join(profile, "gea/bootstrap"), { recursive: true });
    const manifest = JSON.stringify({
      dependencies: {
        "@cleverc2200/dsh-agent-workbench": "keep",
        "dsh-agent-manage": "keep",
        "@cleverc2200/gea-dsh-prototype": "keep",
        "@changfenhuang/dsh-genui": "keep",
      },
      dsh: { profile: { bundles: ["user-choice"] } },
    });
    await writeFile(join(profile, "package.json"), manifest);
    await writeFile(record, receipt);
    await assert.rejects(
      bootstrapCompanyProfile({
        root: "unused",
        support: "unused",
        seed: "unused",
        home,
      }),
      /GEA_COMPANY_INSTALL_INCOMPLETE/,
    );
    assert.equal(await readFile(record, "utf8"), receipt);
    assert.equal(await readFile(join(profile, "package.json"), "utf8"), manifest);
  }
});

test("a damaged bundled archive stops first installation before creating the user profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gea-bootstrap-integrity-"));
  const seed = join(directory, "seed");
  await mkdir(join(seed, "archives"), { recursive: true });
  const names = [
    "@cleverc2200/dsh-agent-workbench",
    "dsh-agent-manage",
    "@cleverc2200/gea-dsh-prototype",
    "@changfenhuang/dsh-genui",
  ];
  await writeFile(join(seed, "archives/first.tgz"), "changed");
  await writeFile(
    join(seed, "manifest.json"),
    JSON.stringify({
      schema: 1,
      packages: names.map((name) => ({
        name,
        version: "1.0.0",
        file: "first.tgz",
        sha256: "0".repeat(64),
      })),
    }),
  );
  const home = join(directory, "home");
  await assert.rejects(
    bootstrapCompanyProfile({ root: "unused", support: "unused", seed, home }),
    /GEA_SEED_ARCHIVE_CHANGED/,
  );
  await assert.rejects(access(home), { code: "ENOENT" });
});

test("the packaged seed rejects missing plugins and paths outside its archives directory", async () => {
  const seed = await mkdtemp(join(tmpdir(), "gea-bootstrap-manifest-"));
  await writeFile(join(seed, "manifest.json"), JSON.stringify({ schema: 1, packages: [] }));
  await assert.rejects(readCompanySeed(seed), /GEA_SEED_INVALID/);
  const names = [
    "@cleverc2200/dsh-agent-workbench",
    "dsh-agent-manage",
    "@cleverc2200/gea-dsh-prototype",
    "@changfenhuang/dsh-genui",
  ];
  await writeFile(
    join(seed, "manifest.json"),
    JSON.stringify({
      schema: 1,
      packages: names.map((name) => ({
        name,
        version: "1",
        file: "../outside.tgz",
        sha256: "0".repeat(64),
      })),
    }),
  );
  await assert.rejects(readCompanySeed(seed), /GEA_SEED_INVALID/);
});

test("only an unchanged profile with a known pre-write store rejection can reach recovery once", async () => {
  for (const variant of ["known", "changed", "other-error", "retried", "all-declared"]) {
    const home = await mkdtemp(join(tmpdir(), "gea-store-recovery-"));
    const profile = join(home, "profiles/desktop");
    const record = join(profile, "gea/bootstrap");
    const log = join(profile, ".plugin-manager/logs/operation-known/pnpm.log");
    await mkdir(record, { recursive: true });
    await mkdir(join(profile, ".plugin-manager/logs/operation-known"), {
      recursive: true,
    });
    const dependencies = {
      "@cleverc2200/dsh-agent-workbench": "old",
      "dsh-agent-manage": "old",
      "@cleverc2200/gea-dsh-prototype": "old",
    };
    if (variant === "all-declared") dependencies["@changfenhuang/dsh-genui"] = "old";
    const files = {
      "package.json": JSON.stringify({ dependencies }),
      "cordis.patch.yml": "- id: preserved\n",
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "pnpm-workspace.yaml": "packages: []\n",
    };
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(profile, name), text);
      await writeFile(join(record, "before-" + name), text);
    }
    const receipt = JSON.stringify({
      status: "failed",
      diagnostic: "GEA_COMPANY_INSTALL_FAILED: " + log,
    });
    await writeFile(join(record, "receipt.json"), receipt);
    await writeFile(
      log,
      variant === "other-error"
        ? "[ERR_PNPM_OTHER]\n"
        : "[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location\n",
    );
    if (variant === "changed")
      await writeFile(join(profile, "cordis.patch.yml"), "user changed configuration\n");
    if (variant === "retried")
      await writeFile(join(record, "before-store-conflict-retry.json"), receipt);
    await assert.rejects(
      bootstrapCompanyProfile({
        root: "unused",
        support: "unused",
        seed: join(home, "absent-seed"),
        home,
      }),
      (error) =>
        variant === "known"
          ? error.code === "ENOENT"
          : error.message === "GEA_COMPANY_INSTALL_INCOMPLETE",
    );
    assert.equal(await readFile(join(record, "receipt.json"), "utf8"), receipt);
  }
});

test("the admitted company Core refresh preserves the existing source and rejects unknown builds", () => {
  const next = {
    ...currentCore,
    head: "8cfb899ccf21d3662421b99b5f4627842ef712ea",
  };
  const source = { channelUrl: "https://example.test/custom.json" };
  assert.deepEqual(planCompanyCoreRefresh({ source, core: currentCore }, next), {
    source,
    core: next,
    checkTimeoutMs: 60000,
    pollIntervalMs: 2000,
  });
  assert.deepEqual(planCompanyCoreRefresh(undefined, next, source).core, next);
  const welcomeCore = { ...next, head: "6f88c3ea2d266ba1825d88bab10d92479a6ffde8" };
  assert.deepEqual(planCompanyCoreRefresh({ source, core: next }, welcomeCore).core, welcomeCore);
  assert.throws(
    () =>
      planCompanyCoreRefresh(
        { source, core: currentCore },
        {
          ...next,
          head: "c".repeat(40),
        },
      ),
    /GEA_CORE_REFRESH_REJECTED/,
  );
});

test("the desktop seed accepts exactly the three required plugins without GenUI", async (t) => {
  const seed = await mkdtemp(join(tmpdir(), "gea-three-plugin-seed-"));
  const { rm } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  t.after(() => rm(seed, { recursive: true, force: true }));
  await mkdir(join(seed, "archives"));
  const bytes = Buffer.from("fixture archive");
  await writeFile(join(seed, "archives/plugin.tgz"), bytes);
  const packages = [
    "@cleverc2200/dsh-agent-workbench",
    "dsh-agent-manage",
    "@cleverc2200/gea-dsh-prototype",
  ].map((name) => ({
    name,
    version: "1.0.0",
    file: "plugin.tgz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  const manifest = { schema: 1, packages };
  await writeFile(join(seed, "manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(await readCompanySeed(seed), manifest);
  await writeFile(
    join(seed, "manifest.json"),
    JSON.stringify({ ...manifest, packages: packages.slice(0, 2) }),
  );
  await assert.rejects(readCompanySeed(seed), /GEA_SEED_INVALID/);
});

test("a registered historical Core cannot enter a new desktop installation", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gea-required-desktop-core-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "app");
  const seed = join(home, "seed");
  await mkdir(join(root, "dsh"), { recursive: true });
  await mkdir(join(seed, "archives"), { recursive: true });
  const runtime = JSON.stringify({
    name: "@deepseek-ai/dsh-desktop-runtime",
    version: "0.2.0-rc.2",
  });
  await writeFile(join(root, "dsh/package.json"), runtime);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      dshBuildCommit: currentCore.head,
      dshBuildDirty: false,
    }),
  );
  const bytes = Buffer.from("fixture archive");
  await writeFile(join(seed, "archives/plugin.tgz"), bytes);
  const packages = [
    "@cleverc2200/dsh-agent-workbench",
    "dsh-agent-manage",
    "@cleverc2200/gea-dsh-prototype",
  ].map((name) => ({
    name,
    version: "1.0.0",
    file: "plugin.tgz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  await writeFile(
    join(seed, "manifest.json"),
    JSON.stringify({
      schema: 1,
      packages,
      core: {
        ...currentCore,
        artifacts: [
          { path: "dsh/package.json", sha256: createHash("sha256").update(runtime).digest("hex") },
        ],
      },
    }),
  );
  await assert.rejects(
    bootstrapCompanyProfile({ root, support: "unused", seed, home: join(home, "profile-home") }),
    /GEA_SEED_CORE_MISMATCH/,
  );
});

test("an existing three-plugin profile without a bootstrap receipt stays untouched", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gea-existing-three-"));
  const { rm } = await import("node:fs/promises");
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, "profiles/desktop");
  await mkdir(profile, { recursive: true });
  const bytes = JSON.stringify({
    dependencies: {
      "@cleverc2200/dsh-agent-workbench": "keep",
      "dsh-agent-manage": "keep",
      "@cleverc2200/gea-dsh-prototype": "keep",
    },
    dsh: { profile: { bundles: ["user-choice"] } },
  });
  await writeFile(join(profile, "package.json"), bytes);
  assert.deepEqual(
    await bootstrapCompanyProfile({
      root: "unused",
      support: "unused",
      seed: "unused",
      home,
    }),
    {
      status: "existing-profile-preserved",
      changed: false,
    },
  );
  assert.equal(await readFile(join(profile, "package.json"), "utf8"), bytes);
  await assert.rejects(access(join(profile, "gea/bootstrap/receipt.json")), {
    code: "ENOENT",
  });
});

async function bomProfile(t) {
  const home = await mkdtemp(join(tmpdir(), "gea-profile-encoding-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, "profiles/desktop");
  const root = join(home, "app");
  const atomic = join(root, "dsh/node_modules/@deepseek-ai/dsh-atomic-write");
  await mkdir(profile, { recursive: true });
  await mkdir(atomic, { recursive: true });
  await writeFile(
    join(atomic, "package.json"),
    JSON.stringify({ type: "module", exports: "./index.mjs" }),
  );
  await writeFile(
    join(atomic, "index.mjs"),
    `
import { writeFile, rename, unlink } from "node:fs/promises";
export async function withFileLock(path, run) {
  await writeFile(path + ".lock", String(process.pid), { flag: "wx" });
  try { return await run(); } finally { await unlink(path + ".lock"); }
}
export async function writeFileAtomic(path, bytes, options) {
  await writeFile(path + ".tmp", bytes, { ...options, flag: "wx" });
  await rename(path + ".tmp", path);
}
`,
  );
  const manifest =
    JSON.stringify(
      {
        name: "existing-company-profile",
        dependencies: {
          "@cleverc2200/dsh-agent-workbench": "0.1.17",
          "dsh-agent-manage": "0.6.3-company.23",
          "@cleverc2200/gea-dsh-prototype": "0.0.177",
        },
        dsh: { profile: { bundles: ["dsh-agent-manage"] } },
      },
      null,
      2,
    ) + "\r\n";
  const original = Buffer.from("\uFEFF" + manifest);
  await writeFile(join(profile, "package.json"), original);
  await writeFile(join(profile, "cordis.patch.yml"), "custom: keep\r\n");
  return {
    home,
    root,
    profile,
    original,
    manifest,
    support: "unused",
    seed: "unused",
  };
}

test("a Windows BOM profile is backed up and normalized before the downstream JSON reader runs", async (t) => {
  const f = await bomProfile(t);
  const result = await bootstrapCompanyProfile(f);
  assert.equal(result.status, "existing-profile-preserved");
  assert.equal(result.changed, true);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.profile, "package.json"), "utf8")),
    JSON.parse(f.manifest),
  );
  assert.equal(await readFile(join(f.profile, "package.json"), "utf8"), f.manifest);
  assert.deepEqual(await readFile(result.backup), f.original);
  assert.equal(await readFile(join(f.profile, "cordis.patch.yml"), "utf8"), "custom: keep\r\n");
  const again = await bootstrapCompanyProfile(f);
  assert.deepEqual(again, {
    status: "existing-profile-preserved",
    changed: false,
  });
  assert.equal((await readdir(join(f.profile, "gea/bootstrap/profile-encoding"))).length, 1);
});

test("BOM normalization leaves failed refreshes, active installs, invalid JSON and linked profiles untouched", async (t) => {
  for (const variant of ["refresh", "busy", "invalid", "linked"]) {
    const f = await bomProfile(t);
    if (variant === "refresh") {
      const dir = join(f.profile, "gea/bootstrap/gea-refresh");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "receipt.json"),
        JSON.stringify({ status: "failed", from: "0.0.159", to: "0.0.177" }),
      );
    }
    if (variant === "busy") {
      await mkdir(join(f.profile, ".plugin-manager"));
      await writeFile(join(f.profile, ".plugin-manager/run.json"), "{}");
    }
    if (variant === "invalid") {
      f.original = Buffer.from("\uFEFF{broken");
      await writeFile(join(f.profile, "package.json"), f.original);
    }
    if (variant === "linked") {
      await writeFile(join(f.home, "linked.json"), f.original);
      await rm(join(f.profile, "package.json"));
      await symlink(join(f.home, "linked.json"), join(f.profile, "package.json"));
    }
    await assert.rejects(
      bootstrapCompanyProfile(f),
      variant === "refresh"
        ? /GEA_REFRESH_RECOVERY_REQUIRED/
        : variant === "busy"
          ? /GEA_REFRESH_PROFILE_BUSY/
          : variant === "linked"
            ? /GEA_PROFILE_ENCODING_UNSAFE_PATH/
            : SyntaxError,
    );
    assert.deepEqual(await readFile(join(f.profile, "package.json")), f.original);
    await assert.rejects(access(join(f.profile, "gea/bootstrap/profile-encoding")), {
      code: "ENOENT",
    });
  }
});

async function interruptedProfile(t, { partial = false, active = false } = {}) {
  const f = await bomProfile(t);
  await writeFile(join(f.profile, "package.json"), f.manifest);
  const record = join(f.profile, "gea/bootstrap");
  await mkdir(record, { recursive: true });
  const packages = [
    {
      name: "@cleverc2200/dsh-agent-workbench",
      version: "0.1.29",
      file: "workbench.tgz",
    },
    {
      name: "dsh-agent-manage",
      version: "0.6.3-company.31",
      file: "manage.tgz",
    },
    {
      name: "@cleverc2200/gea-dsh-prototype",
      version: "0.0.188",
      file: "gea.tgz",
    },
  ];
  const receipt = JSON.stringify({
    status: "installing",
    packages: packages.map((row) => row.name),
  });
  await writeFile(join(record, "receipt.json"), receipt);
  if (!partial) await writeFile(join(record, "before-package.json"), f.manifest);
  await writeFile(
    join(f.profile, "cordis.patch.yml"),
    "- id: user-choice\n  config:\n    preserved: true\n",
  );
  await mkdir(join(f.profile, "sessions"));
  await writeFile(join(f.profile, "sessions/old.jsonl"), "existing user history\n");
  await mkdir(join(f.profile, ".plugin-manager"));
  await writeFile(
    join(f.profile, ".plugin-manager/run.json"),
    JSON.stringify({ pid: active ? process.pid : 2147483647, grouped: false }),
  );
  const require = createRequire(import.meta.url);
  await symlink(
    join(require.resolve("yaml/package.json"), ".."),
    join(f.root, "dsh/node_modules/yaml"),
    "dir",
  );
  const required = JSON.parse(
    await readFile(new URL("../scripts/ci-core-policy.json", import.meta.url), "utf8"),
  ).required[0];
  const core = {
    head: required.head,
    version: required.version,
    artifacts: [],
  };
  const app = JSON.stringify({
    dshBuildCommit: core.head,
    dshBuildDirty: false,
  });
  await writeFile(join(f.root, "package.json"), app);
  await writeFile(
    join(f.root, "dsh/package.json"),
    JSON.stringify({
      name: "@deepseek-ai/dsh-desktop-runtime",
      version: core.version,
    }),
  );
  core.artifacts.push({
    path: "package.json",
    sha256: createHash("sha256").update(app).digest("hex"),
  });
  const seed = join(f.home, "seed");
  for (const dir of ["archives", "store", "metadata"])
    await mkdir(join(seed, dir), { recursive: true });
  for (const row of packages) {
    const bytes = Buffer.from(row.name);
    row.sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(seed, "archives", row.file), bytes);
  }
  await writeFile(
    join(seed, "manifest.json"),
    JSON.stringify({
      schema: 1,
      core,
      packages,
      source: { channelUrl: "https://example.test/channel.json" },
    }),
  );
  let calls = 0;
  const install = async ({ beforeInstall, complete }) => {
    const atomic = await import(
      pathToFileURL(join(f.root, "dsh/node_modules/@deepseek-ai/dsh-atomic-write/index.mjs"))
    );
    return atomic.withFileLock(join(f.profile, "package.json"), async () => {
      await beforeInstall();
      calls++;
      const manifest = JSON.parse(await readFile(join(f.profile, "package.json"), "utf8"));
      for (const row of packages) {
        manifest.dependencies[row.name] = row.version;
        await mkdir(join(f.profile, "node_modules", row.name), {
          recursive: true,
        });
        await writeFile(
          join(f.profile, "node_modules", row.name, "package.json"),
          JSON.stringify(row),
        );
      }
      await writeFile(join(f.profile, "package.json"), JSON.stringify(manifest));
      await complete(atomic);
    });
  };
  return { ...f, seed, install, receipt, record, calls: () => calls };
}

test("a bare interrupted three-plugin installation resumes without losing disabled choices or history", async (t) => {
  const f = await interruptedProfile(t);
  const result = await bootstrapCompanyProfile(f);
  assert.equal(result.status, "installed");
  assert.equal(f.calls(), 1);
  const manifest = JSON.parse(await readFile(join(f.profile, "package.json"), "utf8"));
  assert.deepEqual(manifest.dsh.profile.bundles, ["dsh-agent-manage"]);
  const backup = (await readdir(f.record)).find((name) => name.startsWith("interrupted-"));
  assert.equal(await readFile(join(f.record, backup, "receipt.json"), "utf8"), f.receipt);
  assert.equal(
    await readFile(join(f.profile, "sessions/old.jsonl"), "utf8"),
    "existing user history\n",
  );
  assert.match(await readFile(join(f.profile, "cordis.patch.yml"), "utf8"), /preserved: true/);
  assert.equal((await bootstrapCompanyProfile(f)).status, "existing-profile-preserved");
  assert.equal(f.calls(), 1);
});

test("an interrupted initial installation completes three-plugin activation", async (t) => {
  const f = await interruptedProfile(t, { partial: true });
  await bootstrapCompanyProfile(f);
  const manifest = JSON.parse(await readFile(join(f.profile, "package.json"), "utf8"));
  for (const name of [
    "@cleverc2200/dsh-agent-workbench",
    "dsh-agent-manage",
    "@cleverc2200/gea-dsh-prototype",
  ])
    assert(manifest.dsh.profile.bundles.includes(name));
});

test("an interrupted installation does not retry while its package process remains alive", async (t) => {
  const f = await interruptedProfile(t, { active: true });
  const original = await readFile(join(f.profile, "package.json"));
  await assert.rejects(bootstrapCompanyProfile(f), /GEA_REFRESH_PROFILE_BUSY/);
  assert.equal(f.calls(), 0);
  assert.equal(await readFile(join(f.record, "receipt.json"), "utf8"), f.receipt);
  assert.deepEqual(await readFile(join(f.profile, "package.json")), original);
});

test("interrupted recovery retains pending updates and rejects unknown processes and linked configuration", async (t) => {
  for (const variant of ["pending", "unknown-process", "linked"]) {
    const f = await interruptedProfile(t);
    let expected;
    if (variant === "pending") {
      const id = "00000000-0000-4000-8000-000000000000";
      const runtime = join(f.profile, "gea/plugin-updates");
      await mkdir(join(runtime, "operations", id), { recursive: true });
      await writeFile(join(runtime, "latest.json"), JSON.stringify({ id }));
      await writeFile(
        join(runtime, "operations", id, "receipt.json"),
        JSON.stringify({ id, stage: "pending-restart" }),
      );
      expected = /GEA_REFRESH_UPDATE_PENDING/;
    } else if (variant === "unknown-process") {
      await writeFile(
        join(f.profile, ".plugin-manager/run.json"),
        JSON.stringify({ pid: 0, grouped: false }),
      );
      expected = /GEA_REFRESH_PROFILE_BUSY/;
    } else {
      const patch = join(f.profile, "cordis.patch.yml");
      await writeFile(join(f.home, "outside.yml"), await readFile(patch));
      await rm(patch);
      await symlink(join(f.home, "outside.yml"), patch);
      expected = /GEA_COMPANY_INSTALL_UNSAFE_PATH/;
    }
    await assert.rejects(bootstrapCompanyProfile(f), expected);
    assert.equal(f.calls(), 0);
    assert.equal(await readFile(join(f.record, "receipt.json"), "utf8"), f.receipt);
  }
});
