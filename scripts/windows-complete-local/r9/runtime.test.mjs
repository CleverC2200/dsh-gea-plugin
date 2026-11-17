import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  download,
  requestNativeQuit,
  openNativeLog,
  observeStableRuntime,
  trackNativeExit,
  stopNativeProcess,
} from "./runtime.mjs";

test(
  "scheduled app quit disconnects the real inspector before waiting for clean exit",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "r9-inspector-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "node_modules/electron"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(
      join(root, "node_modules/electron/index.js"),
      "exports.app={quit(){clearInterval(globalThis.r9Timer)}};",
    );
    const child = spawn(
      process.execPath,
      [
        "--inspect=127.0.0.1:0",
        "-e",
        "globalThis.r9Timer=setInterval(()=>{},1000);console.log('ready')",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => child.kill());
    const exited = trackNativeExit(child);
    let stderr = "";
    const endpointReady = new Promise((resolve) =>
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
        const url = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+/);
        if (url) resolve(url[0]);
      }),
    );
    await once(child.stdout, "data");
    const socket = new WebSocket(await endpointReady);
    t.after(() => socket.close());
    await once(socket, "open");
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        socket.addEventListener("message", (event) => {
          const result = JSON.parse(event.data);
          if (result.id === 1)
            result.error ? reject(Error(result.error.message)) : resolve(result.result);
        });
        socket.send(JSON.stringify({ id: 1, method, params }));
      });
    const result = await stopNativeProcess({
      pid: child.pid,
      exited,
      timeoutMs: 2000,
      requestQuit: () =>
        requestNativeQuit({
          send,
          disconnect: () => socket.close(),
          packagePath: join(root, "package.json"),
        }),
      force: () => child.kill(),
    });
    assert.equal(result.gracefulExit, true, JSON.stringify(result));
    assert.equal(result.quitAcknowledgement, "acknowledged");
  },
);

test("installer download writes exact bytes, verifies their digest and refuses replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "r9-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("signed-installer-fixture");
  const server = createServer((_request, response) => response.end(bytes));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/installer.exe`;
  const file = join(root, "installer.exe");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await download(url, digest, file), file);
  assert.deepEqual(await readFile(file), bytes);
  await assert.rejects(download(url, digest, file), { code: "EEXIST" });
  await assert.rejects(download(url, "0".repeat(64), join(root, "bad.exe")));
});

const inventory = (phase, entryId = "include:gea-proof") => ({
  status: 200,
  correlated: true,
  ok: true,
  gea: [
    { entryId, moduleName: "@cleverc2200/gea-dsh-prototype", enabled: true, fiberPhase: phase },
  ],
});
const routes = (status) => [
  { path: "/api/gea-html/identity", status },
  { path: "/api/gea/plugin-updates/status", status },
];

test("an opened log accepts real child stdout and stderr", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "r9-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "native.log");
  const log = await openNativeLog(path);
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('out');process.stderr.write('err')"],
    { stdio: ["ignore", log, log] },
  );
  assert.equal((await trackNativeExit(child)).code, 0);
  log.end();
  await once(log, "close");
  assert.equal(await readFile(path, "utf8"), "outerr");
});

test("startup routes do not satisfy the required phase and both observations are fresh", async () => {
  let reads = 0;
  const result = await observeStableRuntime({
    readInventory: async () => inventory(++reads === 1 ? "loading" : "failed"),
    readRoutes: async () => routes(reads === 1 ? 200 : 404),
    phase: "failed",
    status: 404,
    settleMs: 0,
    pollMs: 0,
  });
  assert.equal(reads, 3);
  assert.notEqual(result.first.inventory, result.second.inventory);
  assert.equal(result.first.inventory.gea[0].fiberPhase, "failed");
  assert.equal(result.second.inventory.gea[0].fiberPhase, "failed");
});

for (const [name, next, route] of [
  ["phase", inventory("failed"), routes(200)],
  ["owner", inventory("active", "replacement"), routes(200)],
  ["route", inventory("active"), routes(404)],
])
  test(`a changed ${name} after the wait fails rather than retrying to green`, async () => {
    let calls = 0;
    await assert.rejects(
      observeStableRuntime({
        readInventory: async () => (++calls === 1 ? inventory("active") : next),
        readRoutes: async () => (calls === 1 ? routes(200) : route),
        phase: "active",
        status: 200,
        settleMs: 0,
      }),
    );
    assert.equal(calls, 2);
  });

test("a normal child quit records its actual zero exit without forced cleanup", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdin.resume();process.stdin.once('data',()=>process.exit(0))"],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  const exited = trackNativeExit(child);
  const result = await stopNativeProcess({
    pid: child.pid,
    exited,
    requestQuit: async () => {
      child.stdin.end("quit");
      return {};
    },
    force: async () => {
      throw Error("must not force");
    },
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.forcedTermination, false);
  assert.equal(result.gracefulExit, true);
  assert.equal(result.quitAcknowledgement, "acknowledged");
});

test("a quit evaluation exception and forced cleanup never count as graceful", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const result = await stopNativeProcess({
    pid: child.pid,
    exited: trackNativeExit(child),
    requestQuit: async () => ({ exceptionDetails: { text: "ReferenceError" } }),
    force: async () => {
      child.kill("SIGKILL");
    },
    timeoutMs: 10,
  });
  assert.equal(result.forcedTermination, true);
  assert.equal(result.gracefulExit, false);
  assert.match(result.requestError, /R9_QUIT_EVALUATION_FAILED/);
});

test("a lost inspector reply is distinguished from an exception when the child exited cleanly", async () => {
  const result = await stopNativeProcess({
    pid: 1,
    exited: Promise.resolve({ code: 0, signal: null, error: null }),
    requestQuit: async () => {
      const error = Error("closed");
      error.code = "R9_CDP_CLOSED";
      throw error;
    },
    force: async () => assert.fail("must not force"),
    timeoutMs: 20,
  });
  assert.equal(result.gracefulExit, true);
  assert.equal(result.quitAcknowledgement, "connection-closed-before-reply");
});
