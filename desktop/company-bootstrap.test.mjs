import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapCompanyProfile,
  readCompanySeed,
  planCompanyCoreRefresh,
  refreshCompanyCore,
} from "./company-bootstrap.mjs";
import { createHash } from "node:crypto";
import { symlink, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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
  assert.deepEqual(
    planCompanyCoreRefresh(existing, currentCore, source).source,
    existing.source,
  );
});

test("an existing profile that only added GenUI receives its missing update source and preserves prior settings and receipts", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "gea-existing-update-source-"),
  );
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
    await realpath(
      join(repository, "node_modules/@deepseek-ai/dsh-atomic-write"),
    ),
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
  await writeFile(
    join(seed, "manifest.json"),
    JSON.stringify({ core, source }),
  );
  const patch =
    "- id: gea-proof\n  disabled: false\n  config:\n    knowledge:\n      baseUrl: https://weknora.example.test\n- id: user-disabled\n  disabled: true\n";
  await writeFile(join(profile, "cordis.patch.yml"), patch);
  const receipt = JSON.stringify({
    status: "installed",
    changed: true,
    packages: [{ name: "@changfenhuang/dsh-genui", version: "0.11.3" }],
  });
  await writeFile(join(bootstrap, "receipt.json"), receipt);
  assert.equal(
    (await refreshCompanyCore({ root, seed, home, apply: false })).status,
    "ready",
  );
  assert.equal(
    await readFile(join(profile, "cordis.patch.yml"), "utf8"),
    patch,
  );
  const result = await refreshCompanyCore({ root, seed, home });
  assert.equal(result.status, "update-source-configured");
  assert.equal(await readFile(result.backup, "utf8"), patch);
  assert.equal(
    await readFile(join(bootstrap, "receipt.json"), "utf8"),
    receipt,
  );
  const YAML = await import("yaml");
  const rows = YAML.parse(
    await readFile(join(profile, "cordis.patch.yml"), "utf8"),
  );
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
    planCompanyCoreRefresh(
      { source: updates.source, core: updates.core },
      currentCore,
    ),
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
    assert.throws(
      () => planCompanyCoreRefresh(updates, currentCore),
      /GEA_CORE_REFRESH_REJECTED/,
    );
    assert.deepEqual(updates, before);
  }
  assert.throws(
    () =>
      planCompanyCoreRefresh(
        { core: currentCore },
        { ...currentCore, head: "b".repeat(40) },
      ),
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
      },
      dsh: { profile: { bundles: ["user-choice"] } },
    }),
    "cordis.patch.yml":
      "- id: gea-proof\n  config:\n    knowledge:\n      baseUrl: https://weknora.example.test\n",
    "gea/plugin-updates/latest.json": '{"id":"old","stage":"completed"}',
    "gea/plugin-updates/operations/old/receipt.json":
      '{"version":"0.0.154","stage":"completed"}',
  };
  for (const [name, text] of Object.entries(files))
    await writeFile(join(profile, name), text);
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
    assert.equal(
      await readFile(join(profile, "package.json"), "utf8"),
      manifest,
    );
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
  await writeFile(
    join(seed, "manifest.json"),
    JSON.stringify({ schema: 1, packages: [] }),
  );
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
  for (const variant of [
    "known",
    "changed",
    "other-error",
    "retried",
    "all-declared",
  ]) {
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
    if (variant === "all-declared")
      dependencies["@changfenhuang/dsh-genui"] = "old";
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
      await writeFile(
        join(profile, "cordis.patch.yml"),
        "user changed configuration\n",
      );
    if (variant === "retried")
      await writeFile(
        join(record, "before-store-conflict-retry.json"),
        receipt,
      );
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
