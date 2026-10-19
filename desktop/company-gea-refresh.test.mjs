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
import { refreshBundledGea } from "./company-gea-refresh.mjs";

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

test("an unfinished plugin update blocks refresh before any backup or install write", async (t) => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000000";
  await mkdir(join(f.profile, "gea/plugin-updates/operations", id), { recursive: true });
  await writeFile(join(f.profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
  await writeFile(
    join(f.profile, "gea/plugin-updates/operations", id, "receipt.json"),
    JSON.stringify({ id, stage: "pending-restart" }),
  );
  await assert.rejects(
    refreshBundledGea({
      ...f,
      install: async (options) => {
        await options.beforeInstall();
        assert.fail("pending updates must not install");
      },
    }),
    /GEA_REFRESH_UPDATE_PENDING/,
  );
  await assert.rejects(access(join(f.profile, "gea/bootstrap/gea-refresh")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.profile, "package.json"), "utf8"), JSON.stringify(current));
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
