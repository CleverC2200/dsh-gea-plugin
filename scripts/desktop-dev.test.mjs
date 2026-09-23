import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertRuntimeParity, readRuntimeVersions, sourceProvenance } from "./desktop-dev-parity.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-desktop-dev-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules"), { recursive: true });
  return root;
}

test("desktop dev records the payload runtime and refuses incomplete payloads", async (t) => {
  const payload = await fixture(t);
  const names = [
    "@deepseek-ai/dsh", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
    "@cleverc2200/dsh-agent-workbench", "dsh-agent-manage", "dsh-plugin",
  ];
  for (const name of names) {
    const path = join(payload, "node_modules", name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  }
  await writeFile(join(payload, "package.json"), JSON.stringify({ name: "runtime", version: "2.0.0" }));
  const versions = await readRuntimeVersions(payload);
  assert.equal(Object.keys(versions).length, names.length);
  assert.doesNotThrow(() => assertRuntimeParity(versions));
  const provenance = await sourceProvenance(payload, payload, { name: "gea", version: "0.0.42" });
  assert.equal(provenance.payload.runtime["@deepseek-ai/dsh"], "1.0.0");
  assert.equal(provenance.overlay, "@cleverc2200/gea-dsh-prototype");
  delete versions["dsh-plugin"];
  assert.throws(() => assertRuntimeParity(versions), /DESKTOP_DEV_PAYLOAD_INCOMPLETE/);
});
