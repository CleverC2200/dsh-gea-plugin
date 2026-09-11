import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";
import { profile, readSession, until } from "./profile.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const sessionId = "session-verify-fixture";

async function fixture(t) {
  const runtime = await mkdtemp(resolve(tmpdir(), "gea-verify-"));
  const path = resolve(runtime, "home/sessions/workspace-fixture", sessionId);
  await mkdir(path, { recursive: true });
  const status = {
    authenticated: true,
    source: "https://gea.example.invalid/gea-boot",
    runId: "fixture-current-run",
    mode: "model",
    provider: "gea-analysis",
    model: "fixture-model",
  };
  const server = createServer((request, response) => {
    if (request.url === "/api/gea-proof/status" && request.method === "POST") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, value: status }));
    } else {
      response.setHeader(
        "Set-Cookie",
        "fixture-auth=fixture; HttpOnly; SameSite=Strict",
      );
      response.end("Synthetic verification status fixture");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await writeFile(
    resolve(runtime, "server.log"),
    `dsh web: http://127.0.0.1:${server.address().port}/\n`,
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(runtime, { recursive: true, force: true });
  });
  return {
    runtime,
    status,
    async session({
      format = "gea-workbench-readonly-v1",
      snapshot: patch = {},
      source = {
        kind: "model",
        provider: "gea-analysis",
        model: "fixture-model",
      },
      reason = "completed",
      interrupted = false,
      corrupt = false,
      before = [],
      after = [],
    } = {}) {
      const snapshot = {
        format,
        runId: "fixture-current-run",
        source: "GEA_LIVE_READONLY",
        sourceUrl: "https://gea.example.invalid/gea-boot/sales-plan/plans",
        coverage: "selected-plans-current-detail",
        records: [
          {
            planId: "plan-1",
            detail: {
              currentVersion: {
                id: "version-1",
                planId: "plan-1",
                targetAmount: "9007199254740993.0100",
              },
              skus: [],
              versions: [],
              logs: [],
            },
          },
        ],
        ...patch,
      };
      const json = JSON.stringify(snapshot, null, 2);
      const hash = createHash("sha256").update(json).digest("hex");
      const rows = [
        ...before,
        { type: "turn/start", data: { turn: 1 } },
        {
          type: "user/message",
          data: {
            content: [
              {
                type: "text",
                text: `Read the selected GEA plans.\nGEA_SNAPSHOT_SHA256=${corrupt ? "0".repeat(64) : hash}\n\n${json}`,
              },
            ],
          },
        },
        {
          type: "request/header",
          data: {
            header: {
              config: { provider: source?.provider, model: source?.model },
            },
            reason: "initial",
          },
        },
        {
          type: "assistant/message",
          data: {
            turn: 1,
            step: 0,
            interrupted,
            message: {
              source,
              content: [{ type: "text", text: "Synthetic completed answer." }],
            },
          },
        },
        { type: "turn/end", data: { turn: 1, reason: { kind: reason } } },
        ...after,
      ];
      await writeFile(
        resolve(path, "session.v3.jsonl.zstd"),
        zstdCompressSync(
          Buffer.from(rows.map(JSON.stringify).join("\n") + "\n"),
        ),
      );
      return hash;
    },
    async verify(live = false) {
      const result = await exec(
        process.execPath,
        [
          "scripts/verify.mjs",
          "--runtime",
          runtime,
          "--session",
          sessionId,
          ...(live ? ["--require-live"] : []),
        ],
        { cwd: root },
      );
      return JSON.parse(result.stdout);
    },
  };
}

const rejectsCode = (code) => (error) => error.stderr.includes(code);

test("verification accepts both durable snapshot formats and keeps receipts distinct from live models", async (t) => {
  const app = await fixture(t);
  for (const format of ["gea-readonly-v1", "gea-workbench-readonly-v1"]) {
    const hash = await app.session({
      format,
      source: { kind: "model", provider: "gea-proof", model: "receipt" },
    });
    const report = await app.verify();
    assert.equal(report.snapshotFormat, format);
    assert.equal(report.snapshotHash, hash);
    assert.equal(report.durableSnapshotVerified, true);
    assert.equal(report.firstAnalysisCompleted, true);
    assert.equal(report.freshLiveVerified, false);
    assert.equal(report.analysisProvider, "gea-proof");
    assert.equal(report.analysisModel, "receipt");
    assert.deepEqual(
      JSON.parse(
        await readFile(resolve(app.runtime, "verification.json"), "utf8"),
      ),
      report,
    );
    await assert.rejects(
      app.verify(true),
      rejectsCode("ANALYSIS_PROVIDER_MISMATCH"),
    );
  }
  await app.session({ format: "gea-unrecognized-v2" });
  await assert.rejects(
    app.verify(),
    rejectsCode("UNSUPPORTED_SNAPSHOT_FORMAT"),
  );
  await app.session({ corrupt: true });
  await assert.rejects(app.verify());
  await app.session({ reason: "aborted", interrupted: true });
  await assert.rejects(
    app.verify(),
    rejectsCode("FIRST_ANALYSIS_NOT_COMPLETED"),
  );
});

test("live verification binds the completed analysis to the current exact environment, run and model", async (t) => {
  const app = await fixture(t);
  for (const format of ["gea-readonly-v1", "gea-workbench-readonly-v1"]) {
    await app.session({ format });
    assert.equal((await app.verify(true)).freshLiveVerified, true);
  }
  for (const [snapshot, code] of [
    [
      { runId: "fixture-previous-run" },
      "PREVIOUS_PROCESS_NOT_FRESH_ACCEPTANCE",
    ],
    [{ runId: null }, "SNAPSHOT_RUN_REQUIRED"],
    [
      {
        sourceUrl: "https://gea.example.invalid:4443/gea-boot/sales-plan/plans",
      },
      "SOURCE_URL_MISMATCH",
    ],
    [
      {
        sourceUrl:
          "https://gea.example.invalid/gea-boot/sales-plan/plans?different=1",
      },
      "SOURCE_URL_MISMATCH",
    ],
    [{ source: "GEA_DEMO" }, "LIVE_SOURCE_REQUIRED"],
  ]) {
    await app.session({ snapshot });
    await assert.rejects(app.verify(true), rejectsCode(code));
  }
  await app.session({
    source: { kind: "model", provider: "gea-analysis", model: "other-model" },
    after: [
      {
        type: "model/selection",
        data: { provider: "gea-analysis", model: "fixture-model" },
      },
    ],
  });
  await assert.rejects(
    app.verify(true),
    rejectsCode("ANALYSIS_MODEL_MISMATCH"),
  );
  await app.session({ source: null });
  await assert.rejects(app.verify(true), rejectsCode("MODEL_ANSWER_REQUIRED"));
  await app.session();
  app.status.authenticated = false;
  await assert.rejects(
    app.verify(true),
    rejectsCode("FRESH_GEA_LOGIN_REQUIRED"),
  );
  app.status.authenticated = true;
  app.status.mode = "receipt";
  await assert.rejects(
    app.verify(true),
    rejectsCode("LOCAL_RECEIPT_NOT_MODEL_ACCEPTANCE"),
  );
  app.status.mode = "model";
  for (const base of [
    "https://localhost/gea",
    "https://127.0.0.2/gea",
    "https://[::1]/gea",
    "https://fixture.localhost/gea",
  ]) {
    app.status.source = base;
    await app.session({ snapshot: { sourceUrl: base + "/sales-plan/plans" } });
    await assert.rejects(
      app.verify(true),
      rejectsCode("LOCAL_FIXTURE_NOT_LIVE_ACCEPTANCE"),
    );
  }
  app.status.source = "http://gea.example.invalid/gea";
  await app.session({
    snapshot: { sourceUrl: app.status.source + "/sales-plan/plans" },
  });
  await assert.rejects(
    app.verify(true),
    rejectsCode("INVALID_LIVE_SOURCE_URL"),
  );
});

test("an earlier completed turn cannot validate a later unfinished snapshot analysis", async (t) => {
  const app = await fixture(t);
  await app.session({
    before: [
      { type: "turn/start", data: { turn: 0 } },
      {
        type: "assistant/message",
        data: {
          turn: 0,
          step: 0,
          message: {
            source: {
              kind: "model",
              provider: "gea-analysis",
              model: "fixture-model",
            },
          },
        },
      },
      { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } },
    ],
    reason: "aborted",
    interrupted: true,
  });
  await assert.rejects(
    app.verify(),
    rejectsCode("SNAPSHOT_NOT_IN_FIRST_ANALYSIS"),
  );
});

test(
  "a workbench preview survives the real DSH receipt path and standalone disk verification",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    const planId = "9007199254740993";
    app.route((request, response, reply) => {
      if (request.url.pathname !== "/gea/sales-plan/plans/" + planId)
        return false;
      reply({
        success: true,
        result: {
          currentVersion: {
            id: "version-1",
            planId,
            targetAmount: "9007199254740993.0100",
          },
          skus: [],
          versions: [],
          logs: [],
        },
      });
      return true;
    });
    await app.login();
    const prepared = await app.rpc("workbench/prepare", { planIds: [planId] });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const submitted = await app.rpc("submit", {
      previewId: prepared.value.previewId,
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    await until(
      () => readSession(app.runtime, submitted.value.sessionId),
      (rows) => rows.some((row) => row.type === "turn/end"),
    );
    const { stdout } = await exec(
      process.execPath,
      [
        "scripts/verify.mjs",
        "--runtime",
        app.runtime,
        "--session",
        submitted.value.sessionId,
      ],
      { cwd: root },
    );
    const report = JSON.parse(stdout);
    assert.equal(report.snapshotFormat, "gea-workbench-readonly-v1");
    assert.equal(report.snapshotHash, prepared.value.snapshotHash);
    assert.equal(report.analysisProvider, "gea-proof");
    assert.equal(report.analysisModel, "receipt");
    assert.equal(report.durableSnapshotVerified, true);
    assert.equal(report.freshLiveVerified, false);
  },
);
