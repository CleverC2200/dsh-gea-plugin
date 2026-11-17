import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, utimes } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
const { outputFiles } = await build({
  entryPoints: ["src/host/request-capture.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { GeaRequestCapture } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);
const base = "https://gea.test/gea-boot";
async function bench(t, config) {
  const root = await mkdtemp(join(tmpdir(), "gea-capture-"));
  let identity = { environment: "test", userId: "user", tenantId: "tenant", base };
  const capture = new GeaRequestCapture(
    root,
    () => identity,
    () => base,
    config,
  );
  capture.session = (id) =>
    id
      ? {
          sessionId: id,
          rootSessionId: id.startsWith("child") ? "session-one" : id,
          createdAt: Date.now() + 100,
        }
      : undefined;
  const captures = [capture];
  t.after(async () => {
    for (const current of captures.reverse()) await current.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const begin = (path = "/api/v1/test") => {
    const headers = new Headers({ "X-Access-Token": "sensitive-secret" });
    const ref = capture.begin(base + path, "POST", headers);
    assert.equal(headers.get("X-Request-Id"), ref.row.requestId);
    if (path.endsWith("/chat/completions"))
      assert.equal(headers.get("X-Trace-Id"), ref.row.requestId);
    return ref;
  };
  const rows = (s) =>
    s.files["gea-requests.jsonl"].toString().trim().split("\n").filter(Boolean).map(JSON.parse);
  return {
    root,
    capture,
    addCapture: (value) => captures.push(value),
    begin,
    rows,
    setIdentity: (v) => {
      identity = v;
    },
  };
}
test("independent ledger survives API ring limits, includes unknown paths and genuine shared preparation references", async (t) => {
  const { capture, begin, rows } = await bench(t);
  const prepared = await capture.run("session-one", "prepare", () =>
    capture.prepare(async () => {
      const ref = begin("/ai/gateway/session");
      capture.finish(ref, "completed");
      return { ready: true };
    }),
  );
  capture.run("session-two", "reuse", () => capture.reuse(prepared));
  await Promise.all(
    ["session-one", "session-two"].map((id) =>
      capture.run(id, "business", async () => {
        for (let i = 0; i < 510; i++) {
          const r = begin(i % 2 ? "/api/v1/list" : "/new-path");
          capture.finish(r, "completed");
        }
      }),
    ),
  );
  const one = rows(await capture.snapshot("session-one")),
    two = rows(await capture.snapshot("session-two"));
  assert.equal(new Set(one.map((r) => r.requestId)).size, 511);
  assert.equal(new Set(two.map((r) => r.requestId)).size, 511);
  assert.equal(one[0].requestId, two[0].requestId);
  assert.ok(one.some((r) => r.requestType === "UNKNOWN"));
  assert.ok(
    one.every((r, i) => r.seq === i + 1 && r.sessionId === "session-one" && !r.path.includes("?")),
  );
  assert.equal(JSON.stringify(one).includes("sensitive-secret"), false);
});
test("sales plan writes retain business request IDs and use a fresh trace for each physical send", async (t) => {
  const { capture, rows } = await bench(t);
  for (const path of ["/sales-plan/plans/resubmit", "/sales-plan/plans/versions/v1/actions"]) {
    const traces = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers({ "X-Request-Id": "fixed-command", "X-Trace-Id": "old-trace" });
      const request = capture.run("session-one", "business write", () =>
        capture.begin(base + path, "POST", headers),
      );
      assert.equal(headers.get("X-Request-Id"), "fixed-command");
      assert.equal(request.row.requestId, "fixed-command");
      assert.equal(headers.get("X-Trace-Id"), request.row.traceId);
      assert.match(request.row.traceId, /^[a-f0-9-]{36}$/);
      traces.push(request.row.traceId);
      capture.finish(request, "completed");
    }
    assert.equal(new Set(traces).size, 2);
  }
  const headers = new Headers({ "X-Request-Id": "fixed-command" });
  const read = capture.run("session-one", "business read", () =>
    capture.begin(base + "/api/v1/list", "POST", headers),
  );
  assert.notEqual(headers.get("X-Request-Id"), "fixed-command");
  capture.finish(read, "completed");
  const ledger = rows(await capture.snapshot("session-one"));
  assert.equal(new Set(ledger.filter((row) => row.traceId).map((row) => row.traceId)).size, 4);
});
test("model terminal follows consumer and preserves raw SSE ids with independent D", async (t) => {
  const { capture, begin, rows } = await bench(t);
  const ref = capture.run("child-one", "model", () => begin("/ai/v1/chat/completions"));
  const response = capture.response(
    new Response('data: {"id":"protocol-id"}\n\n', { headers: { "X-Trace-Id": "server-trace" } }),
    ref,
  );
  await response.text();
  assert.equal(ref.row.state, "started");
  capture.diagnostic(ref, "received", 'data: {"id":"protocol-id"}\n\n');
  capture.diagnostic(ref, "assembled", { text: "answer", complete: true });
  capture.finish(ref, "completed");
  const snap = await capture.snapshot("session-one");
  const ledger = rows(snap);
  assert.equal(ledger.at(-1).state, "completed");
  assert.deepEqual(ledger.at(-1).responseHeaders, { "X-Trace-Id": "server-trace" });
  const d = snap.files["gea-diagnostics.jsonl"].toString();
  assert.match(d, /protocol-id/);
  assert.match(d, /child-one/);
  assert.match(d, new RegExp(ref.row.requestId));
});
test("D off, quota and failed writes do not disable the ledger", async (t) => {
  for (const bytes of [0, 1400]) {
    const { capture, begin, rows } = await bench(t, {
      sessionBytes: bytes,
      profileBytes: 5000,
      retentionMs: 1000,
    });
    const r = capture.run("session-one", "model", () => begin("/chat/completions"));
    for (let i = 0; i < 20; i++) capture.diagnostic(r, "received", "text".repeat(300));
    capture.finish(r, "failed", "INVALID_SSE");
    const snap = await capture.snapshot("session-one");
    assert.equal(rows(snap).at(-1).errorCode, "INVALID_SSE");
    assert.ok(snap.missing.some((m) => m.file === "gea-diagnostics.jsonl"));
    assert.ok((snap.files["gea-diagnostics.jsonl"]?.byteLength ?? 0) <= bytes);
  }
});
test("identity boundaries, inflight snapshots, no echo fabrication and upload exclusion", async (t) => {
  const b = await bench(t);
  const { capture, begin, rows } = b;
  const r = capture.run("session-one", "business", () => begin());
  const snap = await capture.snapshot("session-one");
  assert.equal(rows(snap).at(-1).endedAt, undefined);
  capture.run("session-one", "upload", () => begin("/ai/feedback/reports"));
  assert.equal((await capture.snapshot("session-one")).requestIds.size, 1);
  b.setIdentity({ environment: "test", userId: "other", tenantId: "tenant", base });
  const current = capture.run("session-one", "business", () => begin());
  capture.finish(current, "completed");
  const other = await capture.snapshot("session-one");
  assert.deepEqual([...other.requestIds], [current.row.requestId]);
  assert.ok(rows(other).every((row) => row.requestId === current.row.requestId));
  assert.ok(other.missing.some((item) => item.reason.includes("其他登录身份")));
  capture.finish(r, "cancelled");
});

test("D write failure and expiry retain request terminal records", async (t) => {
  const b = await bench(t, { sessionBytes: 8000, profileBytes: 16000, retentionMs: 1000 });
  const ref = b.capture.run("session-one", "model", () => b.begin("/chat/completions"));
  await b.capture.snapshot("session-one");
  const owners = await readdir(b.root);
  const dirs = await readdir(join(b.root, owners[0]));
  const dir = join(b.root, owners[0], dirs[0]);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "diagnostics.jsonl"));
  b.capture.diagnostic(ref, "received", "hello");
  b.capture.finish(ref, "completed");
  const failed = await b.capture.snapshot("session-one");
  assert.equal(b.rows(failed).at(-1).state, "completed");
  assert.ok(failed.missing.some((x) => x.file === "gea-diagnostics.jsonl"));
  await rm(join(dir, "diagnostics.jsonl"), { recursive: true });
  const second = b.capture.run("session-two", "model", () => b.begin("/chat/completions"));
  b.capture.diagnostic(second, "received", "second");
  b.capture.finish(second, "completed");
  await b.capture.snapshot("session-two");
  const states = await readdir(join(b.root, owners[0]));
  for (const state of states) {
    const path = join(b.root, owners[0], state, "diagnostics.jsonl");
    try {
      await utimes(path, new Date(0), new Date(0));
    } catch {}
  }
  const expired = await b.capture.snapshot("session-two");
  assert.equal(expired.files["gea-diagnostics.jsonl"], undefined);
  assert.ok(expired.files["gea-requests.jsonl"]);
  assert.ok(expired.missing.some((x) => x.reason.includes("保留期限")));
});

test("explicit MCP retry relates only the repeated tool operation", async (t) => {
  const { capture } = await bench(t);
  const send = (operation) =>
    capture.begin(
      base + "/ai/gateway/mcp/proxy/mcp",
      "POST",
      new Headers(),
      undefined,
      undefined,
      operation,
    );
  await capture.run("session-one", "MCP tool", () =>
    capture.retrying(async (retry) => {
      const original = send("tools/call:read");
      capture.finish(original, "failed", "SESSION_EXPIRED");
      retry();
      assert.equal(send(undefined).row.retryOfRequestId, undefined);
      assert.equal(send("tools/call:other").row.retryOfRequestId, undefined);
      assert.equal(send("tools/call:read").row.retryOfRequestId, original.row.requestId);
    }),
  );
});

test("a sealed D prefix remains sealed after restart while request recording continues", async (t) => {
  const config = { sessionBytes: 1400, profileBytes: 5000, retentionMs: 1000 };
  const b = await bench(t, config);
  const ref = b.capture.run("session-one", "model", () => b.begin("/chat/completions"));
  b.capture.diagnostic(ref, "received", "large".repeat(1000));
  b.capture.finish(ref, "completed");
  const before = await b.capture.snapshot("session-one");
  await b.capture.dispose();
  const next = new GeaRequestCapture(
    b.root,
    () => ({ environment: "test", userId: "user", tenantId: "tenant", base }),
    () => base,
    config,
  );
  next.session = b.capture.session;
  b.addCapture(next);
  const current = next.run("session-one", "model", () =>
    next.begin(base + "/chat/completions", "POST", new Headers()),
  );
  next.diagnostic(current, "received", "late");
  next.finish(current, "completed");
  const after = await next.snapshot("session-one");
  assert.deepEqual(after.files["gea-diagnostics.jsonl"], before.files["gea-diagnostics.jsonl"]);
  assert.equal(after.requestIds.size, 2);
});

test("snapshot ids and diagnostics use the exported ledger prefix during concurrent capture", async (t) => {
  const b = await bench(t);
  const first = b.capture.run("session-one", "model", () => b.begin("/ai/v1/chat/completions"));
  b.capture.diagnostic(first, "received", "first");
  await b.capture.snapshot("session-one");
  const read = fsPromises.readFile;
  let release, reached;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const reading = new Promise((resolve) => {
    reached = resolve;
  });
  const mocked = t.mock.method(fsPromises, "readFile", async (path, ...args) => {
    if (String(path).endsWith("diagnostics.jsonl")) {
      reached();
      await blocked;
    }
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const pending = b.capture.snapshot("session-one");
    await reading;
    const second = b.capture.run("session-one", "model", () => b.begin("/ai/v1/chat/completions"));
    b.capture.diagnostic(second, "received", "second");
    await new Promise(setImmediate);
    release();
    const snap = await pending;
    assert.deepEqual([...snap.requestIds], [first.row.requestId]);
    assert.deepEqual([...new Set(b.rows(snap).map((row) => row.requestId))], [...snap.requestIds]);
    const diagnostics = snap.files["gea-diagnostics.jsonl"]
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    assert.ok(diagnostics.every((row) => snap.requestIds.has(row.requestId)));
    assert.equal(
      (await b.capture.snapshot("session-one")).requestIds.has(second.row.requestId),
      true,
    );
  } finally {
    release();
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("profile eviction seals an untouched historical session before deleting its diagnostics", async (t) => {
  const config = { sessionBytes: 5000, profileBytes: 1800, retentionMs: 60000 };
  const b = await bench(t, config);
  const first = b.capture.run("session-one", "model", () => b.begin("/chat/completions"));
  b.capture.diagnostic(first, "received", "old-evidence".repeat(70));
  const original = await b.capture.snapshot("session-one");
  assert.ok(original.files["gea-diagnostics.jsonl"].byteLength > 0);
  await b.capture.dispose();
  const next = new GeaRequestCapture(
    b.root,
    () => ({ environment: "test", userId: "user", tenantId: "tenant", base }),
    () => base,
    config,
  );
  next.session = b.capture.session;
  b.addCapture(next);
  const second = next.run("session-two", "model", () =>
    next.begin(base + "/chat/completions", "POST", new Headers()),
  );
  next.diagnostic(second, "received", "other-evidence".repeat(55));
  await next.snapshot("session-two");
  const resumed = next.run("session-one", "model", () =>
    next.begin(base + "/chat/completions", "POST", new Headers()),
  );
  next.diagnostic(resumed, "received", "new-evidence");
  const snapshot = await next.snapshot("session-one");
  assert.equal(snapshot.files["gea-diagnostics.jsonl"], undefined);
  assert.ok(
    snapshot.missing.some(
      (item) => item.file === "gea-diagnostics.jsonl" && item.reason.includes("淘汰"),
    ),
  );
  assert.equal(snapshot.requestIds.size, 2);
});

test("dispose drains cancellation and rejects late callbacks without reopening capture files", async (t) => {
  const b = await bench(t);
  const request = b.capture.run("session-one", "model", () => b.begin("/chat/completions"));
  await b.capture.dispose();
  const before = await b.capture.snapshot("session-one");
  b.capture.fail(request, new Error("late"));
  b.capture.diagnostic(request, "received", "late fragment");
  assert.equal(
    b.capture.run("session-one", "late", () =>
      b.capture.begin(base + "/chat/completions", "POST", new Headers()),
    ),
    undefined,
  );
  await b.capture.dispose();
  const after = await b.capture.snapshot("session-one");
  assert.deepEqual(after.files, before.files);
  assert.equal(b.rows(after).at(-1).state, "cancelled");
  const [owner] = await readdir(b.root);
  const [session] = await readdir(join(b.root, owner));
  const metadata = JSON.parse(
    await fsPromises.readFile(join(b.root, owner, session, "capture.json"), "utf8"),
  );
  assert.equal(metadata.active, false);
});
