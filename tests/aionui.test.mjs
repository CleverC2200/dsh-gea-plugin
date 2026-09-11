import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readDeployment } from "../scripts/deployment.mjs";

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
  const runtime = resolve(dir, "runtime");
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      "scripts/start.mjs",
      "--config",
      path,
      "--runtime",
      runtime,
    ]),
    (e) => e.code === 1 && /AIONUI_RUNTIME_REMOVED/.test(e.stderr),
  );
  assert.equal(requests, 0);
  await assert.rejects(access(runtime), { code: "ENOENT" });
});
