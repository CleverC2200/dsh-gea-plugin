import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readDeployment } from "../scripts/deployment.mjs";
import { sourceWindow, snapshot, hash } from "./fixtures/source-window.mjs";

test("removed AionUi configurations fail before backend discovery, credential reads or profile creation", async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const dir = await mkdtemp(resolve(tmpdir(), "gea-removed-runtime-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const path = resolve(dir, "deployment.json");
  await writeFile(
    path,
    JSON.stringify({
      geaBaseUrl: "https://gea.example.test/gea",
      pageSize: 10,
      periodPageSize: 100,
      requestTimeoutMs: 2000,
      maxSnapshotBytes: 100000,
      analysis: {
        mode: "model",
        source: "aionui",
        backendUrl: `http://127.0.0.1:${server.address().port}`,
        providerId: "gea-personal-test",
        model: "model",
        contextWindow: 32768,
        maxTokens: 2048,
      },
    }),
  );
  await assert.rejects(readDeployment(path), /AIONUI_RUNTIME_REMOVED/);
  const fixture = await sourceWindow(t, "source-host");
  await writeFile(fixture.configFile, await readFile(path));
  fixture.frozen.config.sha256 = hash(await readFile(fixture.configFile));
  await fixture.refresh();
  const before = await snapshot(fixture.runtime);
  const result = fixture.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /AIONUI_RUNTIME_REMOVED/);
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.deepEqual(effects.writes, []);
  assert.deepEqual(effects.processes, []);
  assert.deepEqual(effects.network, []);
  assert.deepEqual(effects.credentialReads, []);
  assert.deepEqual(effects.after, effects.before);
  assert.deepEqual(await snapshot(fixture.runtime), before);
  assert.equal(requests, 0);
});
