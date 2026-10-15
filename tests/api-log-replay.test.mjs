import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const certdir = mkdtempSync(tmpdir() + "/gea-replay-");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    certdir + "/key",
    "-out",
    certdir + "/cert",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
  ],
  { stdio: "ignore" },
);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.on("exit", () => rmSync(certdir, { recursive: true, force: true }));
const compiled = await build({
  entryPoints: ["src/host/business.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const mod = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
);
async function fixture(t) {
  const requests = [];
  let fail = false;
  let delay = false;
  let status = 200;
  const server = createServer(
    {
      key: readFileSync(certdir + "/key"),
      cert: readFileSync(certdir + "/cert"),
    },
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ url: req.url, body, headers: req.headers });
      if (fail) {
        req.socket.destroy();
        return;
      }
      if (delay) {
        return;
      }
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end('{"success":true,"result":{}}');
    },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = "https://127.0.0.1:" + server.address().port;
  const business = new mod.exports.Business({
    geaBaseUrl: origin,
    environment: "test",
    analysisAgentCode: "fixture",
    requestTimeoutMs: 1000,
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "test",
    base: origin,
    auth: {
      token: "fixture-secret",
      tenantId: "0",
      id: "u1",
      name: "Fixture",
      username: "fixture",
    },
  });
  t.after(() => business.dispose());
  const capture = async (path = "/sys/user/getUserInfo", init) => {
    const response = await business.fetchExternal(origin + path, init);
    await response.text();
    return business.apiLogSnapshot({}).records[0];
  };
  return {
    business,
    requests,
    capture,
    origin,
    setStatus: (v) => (status = v),
    setFail: (v) => (fail = v),
    setDelay: (v) => (delay = v),
  };
}
test("normal Business replay returns the captured network failure ID and no-log preflight reason", async (t) => {
  const f = await fixture(t);
  const original = await f.capture();
  f.setFail(true);
  const result = await f.business.apiLogReplay(
    { id: original.id, confirmed: false },
    new AbortController().signal,
  );
  assert.equal(result.outcome, "failed");
  assert.ok(result.recordId);
  const failed = f.business.apiLogSnapshot({}).records.find((r) => r.id === result.recordId);
  assert.equal(failed.replayedFrom, original.id);
  assert.equal(failed.source, "replay");
  assert.equal(failed.outcome, "error");
  const missing = await f.business.apiLogReplay(
    { id: "missing", confirmed: false },
    new AbortController().signal,
  );
  assert.equal(missing.recordId, null);
  assert.equal(missing.outcome, "rejected");
});
const signal = () => new AbortController().signal;
async function ended(business, runId) {
  for (let n = 0; n < 150; n++) {
    const run = business.apiLogBatchRead({ runId });
    if (run.status !== "running") return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("batch did not end");
}
test("Business runs the fixed samples serially and preserves skips and specific write confirmation", async (t) => {
  const f = await fixture(t);
  const read = await f.capture();
  const write = await f.capture("/sales-plan/plans/versions/v1/actions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": "write-1",
      "Idempotency-Key": "key-1",
    },
    body: '{"action":"SAVE"}',
  });
  const run = f.business.apiLogBatchStart(
    {
      items: [
        { catalogId: "identity.profile", recordId: read.id },
        { catalogId: "plans.action", recordId: write.id },
        { catalogId: "identity.permissions", recordId: null },
        { catalogId: "gateway.session", recordId: null },
      ],
      confirmedWriteIds: [],
    },
    signal(),
  );
  const result = await ended(f.business, run.runId);
  assert.deepEqual(
    result.items.map((i) => i.status),
    ["replayed", "skipped", "skipped", "skipped"],
  );
  assert.equal(f.requests.length, 3);
  const replay = f.business.apiLogSnapshot({}).records[0];
  assert.equal(replay.replayedFrom, read.id);
  assert.equal(replay.source, "api-batch");
  assert.equal(replay.runId, run.runId);
  const confirmed = f.business.apiLogBatchStart(
    {
      items: [{ catalogId: "plans.action", recordId: write.id }],
      confirmedWriteIds: [write.id],
    },
    signal(),
  );
  await ended(f.business, confirmed.runId);
  assert.equal(f.requests.at(-1).body, '{"action":"SAVE"}');
  assert.equal(f.requests.at(-1).headers["x-request-id"], "write-1");
  assert.equal(f.requests.at(-1).headers["idempotency-key"], "key-1");
});
test("stop aborts the in-flight write, preserves its unknown result and never dispatches the next item", async (t) => {
  const f = await fixture(t);
  const write = await f.capture("/sales-plan/plans/versions/v1/actions", {
    method: "POST",
    body: '{"action":"SAVE"}',
  });
  const read = await f.capture();
  f.setDelay(true);
  const run = f.business.apiLogBatchStart(
    {
      items: [
        { catalogId: "plans.action", recordId: write.id },
        { catalogId: "identity.profile", recordId: read.id },
      ],
      confirmedWriteIds: [write.id],
    },
    signal(),
  );
  while (f.requests.length < 3) await new Promise((r) => setTimeout(r, 5));
  f.business.apiLogBatchStop({ runId: run.runId });
  const result = await ended(f.business, run.runId);
  assert.equal(result.status, "stopped");
  assert.equal(result.items[0].status, "cancelled");
  assert.equal(result.items[0].resultUnknown, true);
  assert.ok(result.items[0].logRecordId);
  assert.equal(result.items[1].status, "not-run");
  assert.equal(f.requests.length, 3);
});
test("logout cancels old replay and hides old principal batches from the new login", async (t) => {
  const f = await fixture(t);
  const read = await f.capture();
  f.setDelay(true);
  const pending = f.business.apiLogReplay({ id: read.id, confirmed: false }, signal());
  while (f.requests.length < 2) await new Promise((r) => setTimeout(r, 5));
  f.business.logout({});
  const result = await pending;
  assert.equal(result.outcome, "cancelled");
  assert.ok(result.recordId);
});
test("batch rejects mutable request inputs, mismatched catalog samples and never substitutes cleared samples", async (t) => {
  const f = await fixture(t);
  const read = await f.capture();
  assert.throws(
    () =>
      f.business.apiLogBatchStart(
        {
          items: [
            {
              catalogId: "identity.profile",
              recordId: read.id,
              url: "https://other",
            },
          ],
          confirmedWriteIds: [],
        },
        signal(),
      ),
    /INVALID_API_BATCH/,
  );
  const wrong = f.business.apiLogBatchStart(
    {
      items: [{ catalogId: "identity.permissions", recordId: read.id }],
      confirmedWriteIds: [],
    },
    signal(),
  );
  assert.equal((await ended(f.business, wrong.runId)).items[0].status, "skipped");
  f.business.apiLogClear({});
  await f.capture();
  const cleared = f.business.apiLogBatchStart(
    {
      items: [{ catalogId: "identity.profile", recordId: read.id }],
      confirmedWriteIds: [],
    },
    signal(),
  );
  const result = await ended(f.business, cleared.runId);
  assert.match(result.items[0].reason, /淘汰或清空/);
  assert.equal(f.requests.length, 2);
});
test("history retains only the latest 20 ended batches and respects principal ownership", async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 23; n++) {
    const run = f.business.apiLogBatchStart(
      {
        items: [{ catalogId: "identity.profile", recordId: null }],
        confirmedWriteIds: [],
      },
      signal(),
    );
    await ended(f.business, run.runId);
  }
  assert.equal(f.business.apiLogBatchRead({}).length, 20);
  const prior = f.business.apiLogBatchRead({})[0].runId;
  const saved = f.business.desktopLoginSnapshot();
  f.business.logout({});
  f.business.restoreDesktopLogin(saved);
  assert.deepEqual(f.business.apiLogBatchRead({}), []);
  assert.throws(() => f.business.apiLogBatchRead({ runId: prior }), /API_BATCH_NOT_FOUND/);
});
test("active batch survives history retention and the shared coordinator refuses overlapping replay", async (t) => {
  const f = await fixture(t);
  const read = await f.capture();
  for (let n = 0; n < 20; n++) {
    const run = f.business.apiLogBatchStart(
      {
        items: [{ catalogId: "identity.profile", recordId: null }],
        confirmedWriteIds: [],
      },
      signal(),
    );
    await ended(f.business, run.runId);
  }
  f.setDelay(true);
  const active = f.business.apiLogBatchStart(
    {
      items: [{ catalogId: "identity.profile", recordId: read.id }],
      confirmedWriteIds: [],
    },
    signal(),
  );
  assert.equal(f.business.apiLogBatchRead({}).length, 21);
  const overlap = await f.business.apiLogReplay({ id: read.id, confirmed: false }, signal());
  assert.equal(overlap.outcome, "rejected");
  assert.equal(overlap.reason, "DEBUG_RUN_ACTIVE");
  assert.equal(overlap.recordId, null);
  f.business.apiLogBatchStop({ runId: active.runId });
  await ended(f.business, active.runId);
  assert.equal(f.business.apiLogBatchRead({}).length, 20);
});

test("ordinary Business network failure retains its network error code", async (t) => {
  const f = await fixture(t);
  f.setFail(true);
  await assert.rejects(f.capture(), (error) => error.code === "GEA_NETWORK_FAILED");
});

test("concurrent daily requests keep their origin while batch replays carry only their own run context", async (t) => {
  const f = await fixture(t);
  const original = await f.capture();
  const run = f.business.apiLogBatchStart(
    {
      items: [{ catalogId: "identity.profile", recordId: original.id }],
      confirmedWriteIds: [],
    },
    signal(),
  );
  await f.capture("/sys/permission/getPermCode");
  await ended(f.business, run.runId);
  const records = f.business.apiLogSnapshot({}).records;
  const daily = records.find((record) => record.catalogId === "identity.permissions");
  const replayed = records.find((record) => record.source === "api-batch");
  assert.equal(daily.source, "daily");
  assert.equal(daily.runId, undefined);
  assert.equal(daily.replayedFrom, undefined);
  assert.equal(replayed.runId, run.runId);
  assert.equal(replayed.replayedFrom, original.id);
});

test("evicted fixed samples are skipped after the normal 500-record buffer fills, even when a newer sample exists", async (t) => {
  const f = await fixture(t);
  const original = await f.capture();
  for (let n = 0; n < 500; n++) await f.capture("/sys/user/getUserInfo?fixture=" + n);
  assert.equal(f.business.apiLogSnapshot({}).records.length, 500);
  const run = f.business.apiLogBatchStart(
    {
      items: [{ catalogId: "identity.profile", recordId: original.id }],
      confirmedWriteIds: [],
    },
    signal(),
  );
  const result = await ended(f.business, run.runId);
  assert.equal(result.items[0].status, "skipped");
  assert.match(result.items[0].reason, /淘汰或清空/);
  assert.equal(f.requests.length, 501);
});

test("current bound replay 401 expires the authoritative identity and cancels the batch before another dispatch", async (t) => {
  const f = await fixture(t);
  const init = {
    headers: { "X-Access-Token": "fixture-secret", "X-Tenant-Id": "0" },
  };
  const a = await f.capture("/sys/user/getUserInfo", init),
    b = await f.capture("/sys/permission/getPermCode", init);
  f.setStatus(401);
  f.business.apiLogBatchStart(
    {
      items: [
        { catalogId: a.catalogId, recordId: a.id },
        { catalogId: b.catalogId, recordId: b.id },
      ],
      confirmedWriteIds: [],
    },
    signal(),
  );
  for (let n = 0; n < 100 && f.business.status().authenticated; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.business.status().loginState, "expired");
  assert.equal(f.requests.length, 3);
  assert.throws(() => f.business.apiLogSnapshot({}), /LOGIN/);
});
test("late old 401 cannot expire a replacement login even when the login token is reused", async (t) => {
  const f = await fixture(t);
  const a = await f.capture("/sys/user/getUserInfo", {
    headers: { "X-Access-Token": "fixture-secret", "X-Tenant-Id": "0" },
  });
  const original = globalThis.fetch;
  let release;
  globalThis.fetch = async () =>
    new Promise((resolve) => {
      release = () => resolve(Response.json({ success: false }, { status: 401 }));
    });
  t.after(() => {
    globalThis.fetch = original;
  });
  const pending = f.business.apiLogReplay({ id: a.id, confirmed: false }, signal());
  while (!release) await new Promise((r) => setTimeout(r, 5));
  f.business.logout({});
  f.business.restoreDesktopLogin({
    schema: 1,
    environment: "test",
    base: f.origin,
    auth: {
      token: "fixture-secret",
      tenantId: "0",
      id: "u2",
      name: "New",
      username: "new",
    },
  });
  release();
  await pending;
  assert.equal(f.business.status().authenticated, true);
  assert.equal(f.business.status().user.id, "u2");
});
