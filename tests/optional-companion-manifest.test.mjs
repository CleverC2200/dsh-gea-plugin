import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import semver from "semver";
import { productionManifest } from "../scripts/production-manifest.mjs";
const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const versions = {
  "@cleverc2200/dsh-agent-workbench": "0.1.10",
  "dsh-agent-manage": source.peerDependencies["dsh-agent-manage"],
  "@changfenhuang/dsh-genui": "0.11.3",
  "dsh-better-sidebar": "0.24.1",
};
test("ordinary three-package manifest keeps required companions and exact optional enhancement peers", () => {
  const manifest = productionManifest(source, versions);
  for (const name of ["@cleverc2200/dsh-agent-workbench", "dsh-agent-manage"]) {
    assert.equal(manifest.peerDependencies[name], source.peerDependencies[name] ?? versions[name]);
    assert.notEqual(manifest.peerDependenciesMeta?.[name]?.optional, true);
  }
  for (const name of ["@changfenhuang/dsh-genui", "dsh-better-sidebar"]) {
    assert.equal(manifest.peerDependencies[name], versions[name]);
    assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true);
    assert.equal(manifest.dependencies[name], undefined);
  }
  assert.equal(manifest.peerDependencies["@deepseek-ai/cordis"], "4.0.4 || 4.0.5-alpha.1");
});
test("production manifest preserves an existing exact peer when another package gets an independent version", () => {
  const manifest = productionManifest(source, {
    ...versions,
    "dsh-agent-manage": "0.6.3-company.7",
  });
  assert.equal(
    manifest.peerDependencies["dsh-agent-manage"],
    source.peerDependencies["dsh-agent-manage"],
  );
  assert.notEqual(manifest.peerDependencies["dsh-agent-manage"], "0.6.3-company.7");
  const ranged = productionManifest(
    {
      ...source,
      peerDependencies: {
        ...source.peerDependencies,
        "dsh-agent-manage": "^0.6.3",
      },
    },
    versions,
  );
  assert.equal(ranged.peerDependencies["dsh-agent-manage"], "^0.6.3");
});
test("production manifest accepts Manage company.20 and the previously supported releases", () => {
  const manifest = productionManifest(source, {
    ...versions,
    "dsh-agent-manage": "0.6.3-company.19",
  });
  for (const version of [
    "0.6.3-company.16",
    "0.6.3-company.17",
    "0.6.3-company.18",
    "0.6.3-company.19",
    "0.6.3-company.20",
  ]) {
    assert.equal(
      semver.satisfies(version, manifest.peerDependencies["dsh-agent-manage"]),
      true,
      `production manifest must accept Manage ${version}`,
    );
  }
});
test("production manifest accepts Workbench .9 and .10 but rejects undeclared versions", () => {
  const manifest = productionManifest(source, versions);
  const range = manifest.peerDependencies["@cleverc2200/dsh-agent-workbench"];
  for (const version of ["0.1.9", "0.1.10"])
    assert.equal(semver.satisfies(version, range), true, version);
  for (const version of ["0.1.8", "0.1.11"])
    assert.equal(semver.satisfies(version, range), false, version);
});
