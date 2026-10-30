import test from "node:test";
import assert from "node:assert/strict";
import { planBundledCompanyRefresh } from "./company-gea-refresh.mjs";

const name = "@cleverc2200/gea-dsh-prototype";
const companions = [
  {
    name: "@cleverc2200/dsh-agent-workbench",
    from: "0.1.25",
    version: "0.1.28",
    file: "workbench.tgz",
  },
  {
    name: "dsh-agent-manage",
    from: "0.6.3-company.28",
    version: "0.6.3-company.30",
    file: "manage.tgz",
  },
];
const current = {
  dependencies: {
    [name]: "file:/old/gea.tgz",
    "my-plugin": "1.0.0",
    ...Object.fromEntries(companions.map((row) => [row.name, "file:/old/" + row.file])),
  },
  dsh: { profile: { bundles: [name, "my-plugin", ...companions.map((row) => row.name)] } },
};
const bundled = { name, version: "0.0.166" };
const installed = { name, version: "0.0.130" };
const bundledSuite = [...companions, { ...bundled, file: "gea.tgz" }];
const installedSuite = (gea = installed) => [
  ...companions.map((row) => ({ name: row.name, version: row.from })),
  gea,
];

test("an older company release produces a complete bundled suite plan", () => {
  const before = structuredClone(current);
  const plan = planBundledCompanyRefresh(current, installedSuite(), bundledSuite);
  assert.equal(plan.status, "ready");
  assert.deepEqual(
    plan.targets.map((row) => row.name),
    bundledSuite.map((row) => row.name),
  );
  assert.deepEqual(current, before);
  for (const version of ["0.0.167", "0.0.166-beta.1", "custom"])
    assert.equal(
      planBundledCompanyRefresh(current, installedSuite({ name, version }), bundledSuite).changed,
      false,
    );
  assert.equal(planBundledCompanyRefresh(current, bundledSuite, bundledSuite).changed, false);
  assert.throws(
    () => planBundledCompanyRefresh(current, [installed], [bundled]),
    /GEA_BUNDLED_COMPANY_SUITE_REQUIRED/,
  );
});

test("disabled, linked, missing and differently named plugins are preserved", () => {
  for (const manifest of [
    { ...current, dsh: { profile: { bundles: ["my-plugin"] } } },
    { ...current, dependencies: { [name]: "link:/development" } },
    { ...current, dependencies: { [name]: "file:/my-gea" } },
    { ...current, dependencies: {} },
  ])
    assert.equal(
      planBundledCompanyRefresh(manifest, installedSuite(), bundledSuite).changed,
      false,
    );
  assert.equal(
    planBundledCompanyRefresh(
      current,
      installedSuite({ ...installed, name: "my-plugin" }),
      bundledSuite,
    ).changed,
    false,
  );
});

import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { refreshBundledCompanySuite, assertProfileIdle } from "./company-gea-refresh.mjs";
import { refreshCompanyStartup } from "./company-bootstrap.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "gea-refresh-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, "profiles/desktop");
  await mkdir(join(profile, "node_modules", name), { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify(current));
  await writeFile(join(profile, "node_modules", name, "package.json"), JSON.stringify(installed));
  for (const row of companions) {
    await mkdir(join(profile, "node_modules", row.name), { recursive: true });
    await writeFile(
      join(profile, "node_modules", row.name, "package.json"),
      JSON.stringify({ name: row.name, version: row.from }),
    );
  }
  await writeFile(join(profile, "cordis.patch.yml"), "# user configuration\n- id: custom\n");
  await writeFile(join(profile, "pnpm-lock.yaml"), "old lock");
  return {
    home,
    profile,
    root: "unused",
    support: "unused",
    seed: "/bundled",
    manifest: { packages: bundledSuite },
  };
}

test("the refresh installs one complete suite, keeps user configuration and saves original declarations", async (t) => {
  const f = await fixture(t);
  const result = await refreshBundledCompanySuite({
    ...f,
    install: async (options) => {
      assert.deepEqual(
        options.packages,
        bundledSuite.map((row) => "/bundled/archives/" + row.file),
      );
      await options.beforeInstall();
      await writeFile(
        join(f.profile, "package.json"),
        JSON.stringify({
          ...current,
          dependencies: {
            ...current.dependencies,
            ...Object.fromEntries(
              bundledSuite.map((row) => [row.name, "file:/bundled/archives/" + row.file]),
            ),
          },
        }),
      );
      await writeFile(
        join(f.profile, "node_modules", name, "package.json"),
        JSON.stringify(bundled),
      );
      for (const row of companions)
        await writeFile(
          join(f.profile, "node_modules", row.name, "package.json"),
          JSON.stringify({ name: row.name, version: row.version }),
        );
      await options.complete({ writeFileAtomic: writeFile });
    },
  });
  assert.equal(result.changed, true);
  const backup = join(f.profile, "gea/bootstrap/gea-refresh/before-0.0.130-to-0.0.166");
  assert.equal(await readFile(join(backup, "package.json"), "utf8"), JSON.stringify(current));
  assert.equal(await readFile(join(backup, "pnpm-lock.yaml"), "utf8"), "old lock");
  assert.equal(
    await readFile(join(f.profile, "cordis.patch.yml"), "utf8"),
    "# user configuration\n- id: custom\n",
  );
  assert.equal(
    (await refreshBundledCompanySuite({ ...f, install: () => assert.fail("must not reinstall") }))
      .changed,
    false,
  );
});

test("a pending restart defers bundled refresh while strict installation stays blocked", async (t) => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000000";
  const operation = join(f.profile, "gea/plugin-updates/operations", id);
  await mkdir(operation, { recursive: true });
  await writeFile(join(f.profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
  const receipt = JSON.stringify({ id, stage: "pending-restart" });
  await writeFile(join(operation, "receipt.json"), receipt);
  await assert.rejects(assertProfileIdle(f.profile), /GEA_REFRESH_UPDATE_PENDING/);
  const result = await refreshBundledCompanySuite({
    ...f,
    install: () => assert.fail("pending restart must not enter installation"),
  });
  assert.equal(result.status, "pending-restart-preserved");
  assert.equal(result.changed, false);
  assert.equal(await readFile(join(operation, "receipt.json"), "utf8"), receipt);
  await assert.rejects(access(join(f.profile, "gea/bootstrap/gea-refresh")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.profile, "package.json"), "utf8"), JSON.stringify(current));
  const options = { ...f, legacyData: f.home, install: () => assert.fail("must not install") };
  const startup = await refreshCompanyStartup(options);
  assert.equal(startup.refresh.status, "pending-restart-preserved");
  assert.equal(startup.cleanup, null);
  for (const row of bundledSuite)
    await writeFile(join(f.profile, "node_modules", row.name, "package.json"), JSON.stringify(row));
  assert.equal((await refreshCompanyStartup(options)).cleanup, null);
  await writeFile(join(operation, "receipt.json"), JSON.stringify({ id, stage: "completed" }));
  const next = await refreshCompanyStartup(options);
  assert.equal(next.refresh.status, "current-company-suite-preserved");
  assert.ok(next.cleanup);
});

test("a stopped unconfirmed update reaches Host reconciliation without refreshing or cleaning", async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ["-e", ""], { detached: process.platform !== "win32" });
  const pid = child.pid;
  await once(child, "exit");
  const id = "00000000-0000-4000-8000-000000000000";
  const operation = join(f.profile, "gea/plugin-updates/operations", id);
  await mkdir(operation, { recursive: true });
  await writeFile(join(f.profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
  const receipt = {
    id,
    stage: "unknown",
    diagnostic: "PACKAGE_WRITERS_UNCONFIRMED",
    processes: [
      { pid, grouped: process.platform !== "win32", startIdentity: "observed", sawAlive: true },
    ],
  };
  const original = JSON.stringify(receipt);
  await writeFile(join(operation, "receipt.json"), original);
  const options = { ...f, legacyData: f.home, install: () => assert.fail("must not install") };
  const result = await refreshCompanyStartup(options);
  assert.equal(result.refresh.status, "unknown-update-preserved");
  assert.equal(result.refresh.changed, false);
  assert.equal(result.cleanup, null);
  assert.equal(await readFile(join(operation, "receipt.json"), "utf8"), original);
  assert.equal(await readFile(join(f.profile, "package.json"), "utf8"), JSON.stringify(current));
  await assert.rejects(access(join(f.profile, "gea/bootstrap/gea-refresh")), { code: "ENOENT" });
  await assert.rejects(assertProfileIdle(f.profile), /GEA_REFRESH_UPDATE_PENDING/);

  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await writeFile(
      join(operation, "receipt.json"),
      JSON.stringify({ ...receipt, processes: [{ ...receipt.processes[0], grouped: false }] }),
    );
    assert.equal((await refreshCompanyStartup(options)).refresh.status, "unknown-update-preserved");
  } finally {
    Object.defineProperty(process, "platform", platform);
  }

  for (const processes of [
    [],
    [{ ...receipt.processes[0], pid: process.pid }],
    [{ ...receipt.processes[0], startIdentity: null }],
    [{ ...receipt.processes[0], sawAlive: false }],
    [{ ...receipt.processes[0], pid: -1 }],
    [{ ...receipt.processes[0], grouped: process.platform === "win32" }],
  ]) {
    await writeFile(join(operation, "receipt.json"), JSON.stringify({ ...receipt, processes }));
    await assert.rejects(refreshCompanyStartup(options), /GEA_REFRESH_UPDATE_PENDING/);
  }
});

test("interrupted updates, unknown receipts and active writers still block startup refresh", async (t) => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000000";
  const operation = join(f.profile, "gea/plugin-updates/operations", id);
  await mkdir(operation, { recursive: true });
  await writeFile(join(f.profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
  for (const stage of ["accepted", "installing", "verifying", "restoring", "unknown"]) {
    await writeFile(join(operation, "receipt.json"), JSON.stringify({ id, stage }));
    await assert.rejects(
      refreshBundledCompanySuite({ ...f, install: () => assert.fail("must not install") }),
      /GEA_REFRESH_UPDATE_PENDING/,
    );
  }
  await writeFile(
    join(operation, "receipt.json"),
    JSON.stringify({ id: "different", stage: "pending-restart" }),
  );
  await assert.rejects(
    refreshBundledCompanySuite({ ...f, install: () => assert.fail("must not install") }),
    /GEA_REFRESH_UPDATE_UNKNOWN/,
  );
  await writeFile(
    join(operation, "receipt.json"),
    JSON.stringify({ id, stage: "pending-restart" }),
  );
  await mkdir(join(f.profile, ".plugin-manager"));
  await writeFile(join(f.profile, ".plugin-manager/run.json"), "{}");
  await assert.rejects(
    refreshBundledCompanySuite({ ...f, install: () => assert.fail("must not install") }),
    /GEA_REFRESH_PROFILE_BUSY/,
  );
});

test("an update that starts after startup admission is still blocked under the install lock", async (t) => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000000";
  await assert.rejects(
    refreshBundledCompanySuite({
      ...f,
      install: async (options) => {
        const operation = join(f.profile, "gea/plugin-updates/operations", id);
        await mkdir(operation, { recursive: true });
        await writeFile(join(f.profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
        await writeFile(
          join(operation, "receipt.json"),
          JSON.stringify({ id, stage: "pending-restart" }),
        );
        await options.beforeInstall();
        assert.fail("must reject before package-manager writes");
      },
    }),
    /GEA_REFRESH_UPDATE_PENDING/,
  );
  await assert.rejects(access(join(f.profile, "gea/bootstrap/gea-refresh")), { code: "ENOENT" });
});

test("failed refreshes retain their backup and require recovery instead of retrying at next startup", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    refreshBundledCompanySuite({
      ...f,
      install: async (options) => {
        await options.beforeInstall();
        throw Error("package manager failed");
      },
    }),
    /package manager failed/,
  );
  await assert.rejects(
    refreshBundledCompanySuite({ ...f, install: () => assert.fail("must not retry") }),
    /GEA_REFRESH_RECOVERY_REQUIRED/,
  );
  const receipt = JSON.parse(
    await readFile(join(f.profile, "gea/bootstrap/gea-refresh/receipt.json")),
  );
  assert.equal(receipt.status, "failed");
  await access(join(f.profile, "gea/bootstrap/gea-refresh/before-0.0.130-to-0.0.166/package.json"));
});

import { createHash } from "node:crypto";
import { prepareCompanyArchives } from "./company-archives.mjs";

async function legacyArchives(t) {
  const f = await fixture(t);
  const seed = join(f.home, "new-client/company-seed");
  const old = join(f.home, "removed-client/company-seed/archives");
  const root = join(f.home, "app");
  const yaml = join(root, "dsh/node_modules/yaml");
  await mkdir(yaml, { recursive: true });
  await writeFile(join(yaml, "package.json"), '{"main":"index.cjs"}');
  await writeFile(
    join(yaml, "index.cjs"),
    "exports.parse = JSON.parse; exports.stringify = JSON.stringify;",
  );
  await mkdir(join(seed, "archives"), { recursive: true });
  const versions = {
    "@cleverc2200/dsh-agent-workbench": ["0.1.8", "0.1.17"],
    "dsh-agent-manage": ["0.6.3-company.15", "0.6.3-company.23"],
    [name]: ["0.0.159", "0.0.177"],
  };
  const dependencies = {};
  const packages = [];
  for (const [packageName, [previous, next]] of Object.entries(versions)) {
    const prefix = packageName.replace(/^@/, "").replace("/", "-");
    dependencies[packageName] = "file:" + join(old, prefix + "-" + previous + ".tgz");
    await mkdir(join(f.profile, "node_modules", packageName), { recursive: true });
    await writeFile(
      join(f.profile, "node_modules", packageName, "package.json"),
      JSON.stringify({ name: packageName, version: previous }),
    );
    const bytes = Buffer.from(packageName + "@" + next);
    const file = prefix + "-" + next + ".tgz";
    await writeFile(join(seed, "archives", file), bytes);
    packages.push({
      name: packageName,
      version: next,
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const genui = "@changfenhuang/dsh-genui";
  dependencies[genui] = "file:" + join(old, "dsh-genui-0.11.3.tgz");
  await mkdir(join(f.profile, "node_modules", genui), { recursive: true });
  await writeFile(
    join(f.profile, "node_modules", genui, "package.json"),
    JSON.stringify({ name: genui, version: "0.11.3" }),
  );
  const genuiBytes = Buffer.from("locked original GenUI archive");
  await mkdir(old, { recursive: true });
  const oldGenui = join(old, "dsh-genui-0.11.3.tgz");
  await writeFile(oldGenui, genuiBytes);
  const lock = {
    importers: { ".": { dependencies: { [genui]: { specifier: dependencies[genui] } } } },
    packages: {
      [genui + "@" + dependencies[genui]]: {
        resolution: {
          tarball: dependencies[genui],
          integrity: "sha512-" + createHash("sha512").update(genuiBytes).digest("base64"),
        },
      },
    },
  };
  await writeFile(join(f.profile, "pnpm-lock.yaml"), JSON.stringify(lock));
  await writeFile(join(f.profile, "package.json"), JSON.stringify({ ...current, dependencies }));
  const manifest = { packages };
  await writeFile(join(seed, "manifest.json"), JSON.stringify(manifest));
  return {
    ...f,
    seed,
    root,
    manifest,
    genuiBytes,
    oldGenui,
    packages: [join(seed, "archives", packages[2].file)],
  };
}

test("removed client archive references move to persistent storage and preserve the exact locked optional GenUI", async (t) => {
  const f = await legacyArchives(t);
  const original = await readFile(join(f.profile, "package.json"));
  const result = await prepareCompanyArchives(f);
  assert.equal(result.packages.length, 4);
  assert.equal(result.replacements.length, 4);
  assert.equal(
    result.replacements.find((row) => row.name === "@changfenhuang/dsh-genui").version,
    "0.11.3",
  );
  for (const path of result.packages)
    assert.ok(path.startsWith(join(f.home, "desktop-company-cache/archives")));
  await rm(join(f.home, "new-client"), { recursive: true });
  for (const path of result.packages) await access(path);
  assert.deepEqual(await readFile(join(f.profile, "package.json")), original);
});

test("legacy archive recovery rejects changed bytes and refuses to downgrade a newer company plugin", async (t) => {
  for (const variant of ["integrity", "downgrade"]) {
    const f = await legacyArchives(t);
    const original = await readFile(join(f.profile, "package.json"));
    if (variant === "integrity") await writeFile(f.oldGenui, "changed");
    if (variant === "downgrade")
      await writeFile(
        join(f.profile, "node_modules/@cleverc2200/dsh-agent-workbench/package.json"),
        JSON.stringify({ name: "@cleverc2200/dsh-agent-workbench", version: "0.1.20" }),
      );
    await assert.rejects(
      prepareCompanyArchives(f),
      variant === "integrity"
        ? /GEA_LEGACY_ARCHIVE_INTEGRITY_CHANGED/
        : /GEA_LEGACY_ARCHIVE_IDENTITY_CHANGED/,
    );
    assert.deepEqual(await readFile(join(f.profile, "package.json")), original);
  }
});

test("only the logged pre-write missing GenUI archive failure may resume and the original failed receipt is retained", async (t) => {
  for (const variant of ["known", "changed", "other", "retried"]) {
    const f = await legacyArchives(t);
    const directory = join(f.profile, "gea/bootstrap/gea-refresh");
    const backup = join(directory, "before-0.0.159-to-0.0.177");
    const log = join(f.profile, ".plugin-manager/logs/operation-known/pnpm.log");
    await mkdir(backup, { recursive: true });
    await mkdir(join(f.profile, ".plugin-manager/logs/operation-known"), { recursive: true });
    const profile = JSON.parse(await readFile(join(f.profile, "package.json")));
    const oldGenui = profile.dependencies["@changfenhuang/dsh-genui"].slice(5);
    await writeFile(
      log,
      variant === "other"
        ? "[ERR_PNPM_OTHER] unexpected failure\n"
        : "Progress: resolved 4\n[ENOENT] ENOENT: no such file or directory, open '" +
            oldGenui +
            "'\n",
    );
    for (const file of ["package.json", "cordis.patch.yml", "pnpm-lock.yaml"])
      await writeFile(join(backup, file), await readFile(join(f.profile, file)));
    const failed = JSON.stringify({
      status: "failed",
      changed: false,
      from: "0.0.159",
      to: "0.0.177",
      diagnostic: "GEA_COMPANY_INSTALL_FAILED: " + log,
    });
    await writeFile(join(directory, "receipt.json"), failed);
    if (variant === "changed")
      await writeFile(join(f.profile, "cordis.patch.yml"), "changed by user");
    if (variant === "retried") await writeFile(join(backup, "failed-receipt.json"), failed);
    const task = refreshBundledCompanySuite({
      ...f,
      install: async (options) => {
        await options.beforeInstall();
        for (const row of f.manifest.packages)
          await writeFile(
            join(f.profile, "node_modules", row.name, "package.json"),
            JSON.stringify({ name: row.name, version: row.version }),
          );
        await options.complete({ writeFileAtomic: writeFile });
      },
    });
    if (variant === "known") {
      assert.equal((await task).status, "completed");
      assert.equal(await readFile(join(backup, "failed-receipt.json"), "utf8"), failed);
    } else {
      await assert.rejects(task, /GEA_REFRESH_RECOVERY_REQUIRED/);
      assert.equal(await readFile(join(directory, "receipt.json"), "utf8"), failed);
    }
  }
});

test("the same bundled GEA version still repairs old installer archive references once", () => {
  const manifest = {
    ...current,
    dependencies: {
      ...current.dependencies,
      "@changfenhuang/dsh-genui":
        "file:D:/Program Files/DSH/resources/company-seed/archives/dsh-genui-0.11.3.tgz",
    },
  };
  assert.equal(planBundledCompanyRefresh(manifest, bundledSuite, bundledSuite).status, "ready");
  assert.equal(
    planBundledCompanyRefresh(current, bundledSuite, bundledSuite).status,
    "current-company-suite-preserved",
  );
  assert.equal(
    planBundledCompanyRefresh(
      manifest,
      installedSuite({ ...bundled, version: "0.0.167" }),
      bundledSuite,
    ).status,
    "newer-company-suite-preserved",
  );
});

test("desktop replacement refreshes the whole bundled suite when GEA is already current", async (t) => {
  const f = await fixture(t);
  const versions = [
    ["@cleverc2200/dsh-agent-workbench", "0.1.25", "0.1.28"],
    ["dsh-agent-manage", "0.6.3-company.28", "0.6.3-company.30"],
    [name, "0.0.187", "0.0.187"],
  ];
  const before = structuredClone(current);
  before.dsh.profile.bundles = versions.map(([name]) => name);
  for (const [packageName, version] of versions) {
    before.dependencies[packageName] = "file:/persistent-cache/" + version + ".tgz";
    await mkdir(join(f.profile, "node_modules", packageName), { recursive: true });
    await writeFile(
      join(f.profile, "node_modules", packageName, "package.json"),
      JSON.stringify({ name: packageName, version }),
    );
  }
  await writeFile(join(f.profile, "package.json"), JSON.stringify(before));
  const packages = versions.map(([name, , version], index) => ({
    name,
    version,
    file: "company-" + index + ".tgz",
  }));
  const result = await refreshBundledCompanySuite({
    ...f,
    manifest: { packages },
    install: async (options) => {
      assert.deepEqual(
        options.packages,
        packages.map((row) => "/bundled/archives/" + row.file),
      );
      await options.beforeInstall();
      const after = structuredClone(before);
      for (const row of packages) {
        after.dependencies[row.name] = "file:/bundled/archives/" + row.file;
        await writeFile(
          join(f.profile, "node_modules", row.name, "package.json"),
          JSON.stringify({ name: row.name, version: row.version }),
        );
      }
      await writeFile(join(f.profile, "package.json"), JSON.stringify(after));
      await options.complete({ writeFileAtomic: writeFile });
    },
  });
  assert.equal(result.status, "completed");
  for (const row of packages)
    assert.equal(
      JSON.parse(await readFile(join(f.profile, "node_modules", row.name, "package.json"))).version,
      row.version,
    );
  assert.equal(
    await readFile(join(f.profile, "cordis.patch.yml"), "utf8"),
    "# user configuration\n- id: custom\n",
  );
  assert.equal(
    (
      await refreshBundledCompanySuite({
        ...f,
        manifest: { packages },
        install: () => assert.fail("current suite must not reinstall"),
      })
    ).changed,
    false,
  );
});

test("one disabled, custom or newer companion preserves the complete existing suite", () => {
  for (const companion of companions) {
    const disabled = structuredClone(current);
    disabled.dsh.profile.bundles = disabled.dsh.profile.bundles.filter(
      (name) => name !== companion.name,
    );
    assert.equal(
      planBundledCompanyRefresh(disabled, installedSuite(), bundledSuite).status,
      "disabled-company-profile-preserved",
    );
    const custom = structuredClone(current);
    custom.dependencies[companion.name] = "link:/development";
    assert.equal(
      planBundledCompanyRefresh(custom, installedSuite(), bundledSuite).status,
      "custom-company-profile-preserved",
    );
    const newer = installedSuite().map((row) =>
      row.name === companion.name
        ? { ...row, version: companion.name === "dsh-agent-manage" ? "0.6.3-company.31" : "0.1.29" }
        : row,
    );
    assert.equal(
      planBundledCompanyRefresh(current, newer, bundledSuite).status,
      "newer-company-suite-preserved",
    );
  }
});

test("a partial companion installation cannot publish a successful suite receipt", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    refreshBundledCompanySuite({
      ...f,
      install: async (options) => {
        await options.beforeInstall();
        await writeFile(
          join(f.profile, "node_modules", name, "package.json"),
          JSON.stringify(bundled),
        );
        await options.complete({ writeFileAtomic: writeFile });
      },
    }),
    /GEA_REFRESH_PROFILE_NOT_PRESERVED/,
  );
  const receipt = JSON.parse(
    await readFile(join(f.profile, "gea/bootstrap/gea-refresh/receipt.json")),
  );
  assert.equal(receipt.status, "failed");
});
