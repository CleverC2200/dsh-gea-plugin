import test from "node:test";
import assert from "node:assert/strict";
import { planBundledGeaRefresh } from "./company-gea-refresh.mjs";

const name = "@cleverc2200/gea-dsh-prototype";
const current = {
  dependencies: { [name]: "file:/old/gea.tgz", "my-plugin": "1.0.0" },
  dsh: { profile: { bundles: [name, "my-plugin"] } },
};
const bundled = { name, version: "0.0.166" };
const installed = { name, version: "0.0.130" };

test("only an enabled older GEA release is replaced by the bundled GEA", () => {
  const before = structuredClone(current);
  assert.equal(planBundledGeaRefresh(current, installed, bundled).status, "ready");
  assert.deepEqual(current, before);
  for (const version of ["0.0.166", "0.0.167", "0.0.166-beta.1", "custom"])
    assert.equal(planBundledGeaRefresh(current, { name, version }, bundled).changed, false);
});

test("disabled, linked, missing and differently named plugins are preserved", () => {
  for (const manifest of [
    { ...current, dsh: { profile: { bundles: ["my-plugin"] } } },
    { ...current, dependencies: { [name]: "link:/development" } },
    { ...current, dependencies: { [name]: "file:/my-gea" } },
    { ...current, dependencies: {} },
  ])
    assert.equal(planBundledGeaRefresh(manifest, installed, bundled).changed, false);
  assert.equal(
    planBundledGeaRefresh(current, { ...installed, name: "my-plugin" }, bundled).changed,
    false,
  );
});

import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { refreshBundledGea, assertProfileIdle } from "./company-gea-refresh.mjs";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "gea-refresh-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, "profiles/desktop");
  await mkdir(join(profile, "node_modules", name), { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify(current));
  await writeFile(join(profile, "node_modules", name, "package.json"), JSON.stringify(installed));
  await writeFile(join(profile, "cordis.patch.yml"), "# user configuration\n- id: custom\n");
  await writeFile(join(profile, "pnpm-lock.yaml"), "old lock");
  return {
    home,
    profile,
    root: "unused",
    support: "unused",
    seed: "/bundled",
    manifest: { packages: [{ ...bundled, file: "gea.tgz" }] },
  };
}

test("the refresh installs only GEA, keeps user configuration and saves the original graph declarations", async (t) => {
  const f = await fixture(t);
  const result = await refreshBundledGea({
    ...f,
    install: async (options) => {
      assert.deepEqual(options.packages, ["/bundled/archives/gea.tgz"]);
      await options.beforeInstall();
      await writeFile(
        join(f.profile, "package.json"),
        JSON.stringify({
          ...current,
          dependencies: { ...current.dependencies, [name]: "file:/bundled/archives/gea.tgz" },
        }),
      );
      await writeFile(
        join(f.profile, "node_modules", name, "package.json"),
        JSON.stringify(bundled),
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
    (await refreshBundledGea({ ...f, install: () => assert.fail("must not reinstall") })).changed,
    false,
  );
});

test("a pending restart defers bundled refresh without weakening the strict installation guard", async (t) => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000000";
  await mkdir(join(f.profile, "gea/plugin-updates/operations", id), { recursive: true });
  await writeFile(join(f.profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
  await writeFile(
    join(f.profile, "gea/plugin-updates/operations", id, "receipt.json"),
    JSON.stringify({ id, stage: "pending-restart" }),
  );
  const receipt = await readFile(
    join(f.profile, "gea/plugin-updates/operations", id, "receipt.json"),
  );
  await assert.rejects(assertProfileIdle(f.profile), /GEA_REFRESH_UPDATE_PENDING/);
  const result = await refreshBundledGea({
    ...f,
    install: () => assert.fail("pending updates must not enter installation"),
  });
  assert.equal(result.status, "pending-restart-preserved");
  assert.equal(result.changed, false);
  assert.deepEqual(
    await readFile(join(f.profile, "gea/plugin-updates/operations", id, "receipt.json")),
    receipt,
  );
  await assert.rejects(access(join(f.profile, "gea/bootstrap/gea-refresh")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.profile, "package.json"), "utf8"), JSON.stringify(current));
});

test("unfinished writers and unknown update stages still prevent startup refresh", async (t) => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000000";
  const operation = join(f.profile, "gea/plugin-updates/operations", id);
  await mkdir(operation, { recursive: true });
  await writeFile(join(f.profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
  for (const stage of ["accepted", "installing", "verifying", "restoring", "unknown"]) {
    await writeFile(join(operation, "receipt.json"), JSON.stringify({ id, stage }));
    await assert.rejects(
      refreshBundledGea({ ...f, install: () => assert.fail("must not install") }),
      /GEA_REFRESH_UPDATE_PENDING/,
    );
  }
  await writeFile(
    join(operation, "receipt.json"),
    JSON.stringify({ id, stage: "pending-restart" }),
  );
  await mkdir(join(f.profile, ".plugin-manager"));
  await writeFile(join(f.profile, ".plugin-manager/run.json"), "{}");
  await assert.rejects(
    refreshBundledGea({ ...f, install: () => assert.fail("must not install") }),
    /GEA_REFRESH_PROFILE_BUSY/,
  );
});

test("bundled GEA refresh upgrades older owned companions together and preserves user configuration", async (t) => {
  const f = await fixture(t);
  f.seed = join(f.home, "company-seed");
  await mkdir(join(f.seed, "archives"), { recursive: true });
  const targets = [
    ["@cleverc2200/dsh-agent-workbench", "0.1.21", "0.1.22"],
    ["dsh-agent-manage", "0.6.3-company.24", "0.6.3-company.25"],
  ];
  const before = structuredClone(current);
  const packages = [{ ...bundled, file: "gea.tgz" }];
  for (const [name, previous, version] of targets) {
    before.dependencies[name] = "file:/previous/" + name.replaceAll("/", "-") + ".tgz";
    await mkdir(join(f.profile, "node_modules", name), { recursive: true });
    await writeFile(
      join(f.profile, "node_modules", name, "package.json"),
      JSON.stringify({ name, version: previous }),
    );
    const file = name.replace(/^@/, "").replace("/", "-") + "-" + version + ".tgz";
    const bytes = Buffer.from(name + "@" + version);
    await writeFile(join(f.seed, "archives", file), bytes);
    packages.push({
      name,
      version,
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFile(join(f.profile, "package.json"), JSON.stringify(before));
  f.manifest = { packages };
  for (const [name] of targets) {
    const custom = structuredClone(before);
    custom.dependencies[name] = "link:/user-development";
    await writeFile(join(f.profile, "package.json"), JSON.stringify(custom));
    assert.equal(
      (
        await refreshBundledGea({
          ...f,
          install: () => assert.fail("custom companions must be preserved"),
        })
      ).status,
      "custom-companion-preserved",
    );
    assert.deepEqual(JSON.parse(await readFile(join(f.profile, "package.json"))), custom);
  }
  await writeFile(join(f.profile, "package.json"), JSON.stringify(before));
  const result = await refreshBundledGea({
    ...f,
    install: async (options) => {
      assert.deepEqual(
        options.packages,
        packages.map((row) => join(f.seed, "archives", row.file)),
      );
      await options.beforeInstall();
      const after = structuredClone(before);
      for (const row of packages) {
        after.dependencies[row.name] = "file:" + join(f.seed, "archives", row.file);
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
  assert.equal(
    await readFile(join(f.profile, "cordis.patch.yml"), "utf8"),
    "# user configuration\n- id: custom\n",
  );
  const after = JSON.parse(await readFile(join(f.profile, "package.json")));
  assert.equal(after.dependencies["my-plugin"], before.dependencies["my-plugin"]);
  assert.deepEqual(after.dsh, before.dsh);
});

test("failed refreshes retain their backup and require recovery instead of retrying at next startup", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    refreshBundledGea({
      ...f,
      install: async (options) => {
        await options.beforeInstall();
        throw Error("package manager failed");
      },
    }),
    /package manager failed/,
  );
  await assert.rejects(
    refreshBundledGea({ ...f, install: () => assert.fail("must not retry") }),
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
    const task = refreshBundledGea({
      ...f,
      install: async (options) => {
        await options.beforeInstall();
        const after = structuredClone(profile);
        for (const row of f.manifest.packages) {
          after.dependencies[row.name] = "file:" + join(f.seed, "archives", row.file);
          await writeFile(
            join(f.profile, "node_modules", row.name, "package.json"),
            JSON.stringify({ name: row.name, version: row.version }),
          );
        }
        await writeFile(join(f.profile, "package.json"), JSON.stringify(after));
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
  assert.equal(planBundledGeaRefresh(manifest, bundled, bundled).status, "ready");
  assert.equal(
    planBundledGeaRefresh(current, bundled, bundled).status,
    "current-or-custom-gea-preserved",
  );
  assert.equal(
    planBundledGeaRefresh(manifest, { ...bundled, version: "0.0.167" }, bundled).status,
    "current-or-custom-gea-preserved",
  );
});
