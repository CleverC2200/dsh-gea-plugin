import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { GeaRequestCapture } from "./helpers/feedback-capture.mjs";
const { outputFiles } = await build({
  entryPoints: ["src/host/feedback-submit.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "official-log-port",
      setup(b) {
        b.onResolve({ filter: /^@deepseek-ai\/dsh-session-log-export$/ }, () => ({
          path: "official",
          namespace: "test",
        }));
        b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents:
            "export const sessionLogExportDeps=ctx=>ctx;export const flushLiveSessionLog=(ctx,id)=>ctx.flush(id);export const readSessionLogText=(port,id)=>port.read(id);",
        }));
      },
    },
  ],
});
const { FeedbackSubmitter } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);
async function bench(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-submit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let snapshots = 0;
  const sent = [];
  let fail = true;
  let signal = new AbortController();
  let identity = { environment: "test", userId: "u", tenantId: "t", base: "https://gea.test" };
  const ctx = {
    sessionPersistence: {
      read: async (id) => JSON.stringify({ type: "session", id, version: 4 }) + "\n",
    },
    flush: async () => {},
  };
  const business = {
    config: { runtimeDir: root },
    capture: {
      session: (id) => ({ rootSessionId: id }),
      snapshot: async () => {
        snapshots++;
        return {
          files: { "gea-requests.jsonl": new Uint8Array() },
          missing: [{ file: "gea-diagnostics.jsonl", reason: "off" }],
          requestIds: new Set(),
        };
      },
    },
    apiLogSnapshot: () => ({ records: [] }),
    feedbackOwner: () => ({
      identity,
      signal: signal.signal,
      send: async (form) => {
        const bytes = new Uint8Array(await form.get("file").arrayBuffer());
        sent.push({
          id: form.get("submissionId"),
          description: form.get("description"),
          bytes,
          owner: { ...identity },
        });
        if (fail) throw Error("network");
        return Response.json({
          success: true,
          code: 200,
          result: {
            reportId: "19060d14-8db5-4894-adcf-13e73db786c1",
            receivedAt: "2026-11-05T06:16:07Z",
          },
        });
      },
    }),
  };
  return {
    ctx,
    business,
    sent,
    submitter: new FeedbackSubmitter(ctx, business),
    snapshots: () => snapshots,
    setIdentity: (value) => {
      signal.abort();
      signal = new AbortController();
      identity = { ...identity, ...value };
    },
    succeed: () => {
      fail = false;
    },
  };
}
test("manual retry uses original archive and submission id; description edit freezes a new snapshot", async (t) => {
  const b = await bench(t);
  const request = { sessionId: "session-one", description: "test feedback" };
  assert.equal((await b.submitter.submit(request)).ok, false);
  assert.equal((await b.submitter.submit(request)).ok, false);
  assert.equal(b.snapshots(), 1);
  assert.equal(b.sent[0].id, b.sent[1].id);
  assert.deepEqual(b.sent[0].bytes, b.sent[1].bytes);
  const zip = unzipSync(b.sent[0].bytes);
  const manifest = JSON.parse(strFromU8(zip["manifest.json"]));
  assert.deepEqual(
    manifest.files.sort(),
    Object.keys(zip)
      .filter((k) => k !== "manifest.json")
      .sort(),
  );
  assert.equal(zip["gea-requests.jsonl"].byteLength, 0);
  assert.equal((await b.submitter.submit({ ...request, description: "changed" })).ok, false);
  assert.equal(b.snapshots(), 2);
  assert.notEqual(b.sent[1].id, b.sent[2].id);
  b.succeed();
  assert.equal((await b.submitter.submit({ ...request, description: "changed" })).ok, true);
  assert.deepEqual(b.sent[2].bytes, b.sent[3].bytes);
});
test("missing official log prevents upload even when optional evidence exists", async (t) => {
  const b = await bench(t);
  b.ctx.sessionPersistence.read = async () => undefined;
  assert.equal(
    (await b.submitter.submit({ sessionId: "session-one", description: "test" })).ok,
    false,
  );
  assert.equal(b.sent.length, 0);
  assert.equal(b.snapshots(), 0);
});

test("current login uploads historical official logs with only its own captured materials", async (t) => {
  const b = await bench(t);
  const currentIdentity = () => b.business.feedbackOwner().identity;
  const capture = new GeaRequestCapture(
    join(b.business.config.runtimeDir, "feedback-evidence"),
    currentIdentity,
    () => currentIdentity().base,
  );
  capture.session = (id) => ({ sessionId: id, rootSessionId: id, createdAt: 1 });
  t.after(() => capture.dispose());
  b.business.capture = capture;
  const sessionId = "historical-session";
  const official =
    JSON.stringify({ type: "session", id: sessionId, version: 4 }) +
    '\n{"type":"user/message","data":{"content":"historical owner content"}}\n';
  b.ctx.sessionPersistence.read = async () => official;
  const modelRequest = (text) =>
    capture.run(sessionId, "model", () => {
      const request = capture.begin(
        currentIdentity().base + "/chat/completions",
        "POST",
        new Headers(),
      );
      capture.diagnostic(request, "received", text);
      capture.finish(request, "completed");
      return request.row.requestId;
    });
  const oldRequest = modelRequest("old-owner-diagnostic");
  await capture.snapshot(sessionId);
  b.setIdentity({ userId: "current-user", tenantId: "current-tenant" });
  const currentRequest = modelRequest("current-owner-diagnostic");
  b.business.apiLogSnapshot = () => ({
    records: [oldRequest, currentRequest].map((id) => ({
      request: { headers: { "x-request-id": id } },
    })),
  });
  b.succeed();
  assert.equal(
    (await b.submitter.submit({ sessionId, description: "historical feedback" })).ok,
    true,
  );
  assert.equal(b.sent[0].owner.userId, "current-user");
  assert.equal(b.sent[0].owner.tenantId, "current-tenant");
  const zip = unzipSync(b.sent[0].bytes);
  assert.equal(strFromU8(zip["session.v4.jsonl"]), official);
  const rows = strFromU8(zip["gea-requests.jsonl"]).trim().split("\n").map(JSON.parse);
  assert.deepEqual([...new Set(rows.map((row) => row.requestId))], [currentRequest]);
  const diagnostics = strFromU8(zip["gea-diagnostics.jsonl"]);
  assert.ok(diagnostics.includes("current-owner-diagnostic"));
  assert.ok(!diagnostics.includes("old-owner-diagnostic"));
  const api = strFromU8(zip["gea-api-logs.jsonl"]).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    api.map((row) => row.request.headers["x-request-id"]),
    [currentRequest],
  );
  const manifest = JSON.parse(strFromU8(zip["manifest.json"]));
  assert.ok(manifest.missing.some((item) => item.reason.includes("其他登录身份")));
});

test("switching login replaces a failed snapshot while same-login retries reuse its bytes", async (t) => {
  const b = await bench(t);
  const request = { sessionId: "session-one", description: "test feedback" };
  assert.equal((await b.submitter.submit(request)).ok, false);
  b.setIdentity({ userId: "other-user", tenantId: "other-tenant" });
  assert.equal((await b.submitter.submit(request)).ok, false);
  assert.equal(b.sent.length, 2);
  assert.equal(b.sent[1].owner.userId, "other-user");
  assert.equal(b.sent[1].owner.tenantId, "other-tenant");
  assert.notEqual(b.sent[0].id, b.sent[1].id);
  assert.equal(b.snapshots(), 2);
  b.succeed();
  assert.equal((await b.submitter.submit(request)).ok, true);
  assert.equal(b.sent[1].id, b.sent[2].id);
  assert.deepEqual(b.sent[1].bytes, b.sent[2].bytes);
  assert.equal(b.snapshots(), 2);
});

test("identity changes during freezing stop the upload until explicitly submitted again", async (t) => {
  const b = await bench(t);
  const read = b.ctx.sessionPersistence.read;
  b.ctx.sessionPersistence.read = async (id) => {
    b.setIdentity({ userId: "current-user" });
    return read(id);
  };
  b.succeed();
  const request = { sessionId: "session-one", description: "test feedback" };
  assert.equal((await b.submitter.submit(request)).ok, false);
  assert.equal(b.sent.length, 0);
  b.ctx.sessionPersistence.read = read;
  assert.equal((await b.submitter.submit(request)).ok, true);
  assert.equal(b.sent[0].owner.userId, "current-user");
});

test("identity change while retiring an accepted archive suppresses the stale receipt", async (t) => {
  const b = await bench(t);
  b.succeed();
  const unlink = fsPromises.unlink;
  const mocked = t.mock.method(fsPromises, "unlink", async (path) => {
    b.setIdentity({ userId: "new-user" });
    return unlink(path);
  });
  syncBuiltinESMExports();
  try {
    const result = await b.submitter.submit({ sessionId: "session-one", description: "test" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GEA_FEEDBACK_IDENTITY_MISMATCH");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
