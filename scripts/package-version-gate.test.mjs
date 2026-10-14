import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { productionManifest } from "./production-manifest.mjs";
test("production curation cannot relabel already compiled code as a different package version", async () => {
  const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const versions = {
    [source.name]: "0.0.136",
    "@cleverc2200/dsh-agent-workbench": "0.1.1",
    "dsh-agent-manage": "0.6.3-company.6",
    "@changfenhuang/dsh-genui": "0.11.3",
    "dsh-better-sidebar": "0.24.1",
  };
  assert.throws(() => productionManifest(source, versions), /COMPILED_PACKAGE_VERSION_MISMATCH/);
  versions[source.name] = source.version;
  assert.equal(productionManifest(source, versions).version, source.version);
});
