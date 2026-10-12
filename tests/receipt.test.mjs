import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, writeFile, unlink, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readSession, until } from "./profile.mjs";
import { receiptProfile, assertReceiptMessages } from "./fixtures/receipt-skill-catalog.mjs";

test(
  "one preview submits once through the standard Session and survives a fresh process",
  { timeout: 60000 },
  async (t) => {
    const app = await receiptProfile(t);
    await app.login();
    const page = (await app.rpc("plans")).value;
    const preview = (
      await app.rpc("prepare", {
        queryId: page.queryId,
        planId: page.records[0].planId,
      })
    ).value;
    const results = await Promise.all([
      app.rpc("submit", { previewId: preview.previewId }),
      app.rpc("submit", { previewId: preview.previewId }),
    ]);
    assert.equal(results[0].ok, true, JSON.stringify(results));
    assert.equal(results[0].value.sessionId, results[1].value.sessionId);
    const id = results[0].value.sessionId;
    const rows = await until(
      () => readSession(app.runtime, id),
      (rows) => rows.some((row) => row.type === "turn/end"),
    );
    const messages = rows.filter((row) => row.type === "user/message");
    assertReceiptMessages(rows, app.receiptCore);
    assert.equal(messages.filter((row) => row.data.source.kind === "gea-proof").length, 1);
    const snapshot = messages.find(
      (row) => row.data.source.kind === "gea-proof" || row.data.source.plugin === "gea-proof",
    );
    assert.equal(snapshot.data.source.form, "notice");
    assert.equal(snapshot.data.source.summary, "已提交只读快照，正在验证数据传递");
    assert.equal(
      messages.some((row) => row.data.source.kind === "user"),
      false,
    );
    const archivePath = `${app.runtime}/analysis-snapshots/${id}.json`;
    const archive = JSON.parse(await readFile(archivePath, "utf8"));
    assert.equal(archive.sessionId, id);
    assert.equal(archive.snapshotHash, preview.snapshotHash);
    assert.deepEqual(archive.snapshot, preview.snapshot);
    assert.ok(JSON.stringify(archive.snapshot).includes("1.2300"));
    assert.equal(JSON.stringify(snapshot).includes(preview.snapshotHash), false);
    const answer = rows.find((row) => row.type === "assistant/message");
    assert.ok(answer);
    assert.equal(JSON.stringify(answer).includes(preview.snapshotHash), false);
    assert.equal(JSON.stringify(rows).includes("fixture-gea-token"), false);
    const receipts = (await readFile(app.runtime + "/receipts.jsonl", "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(receipts.length, 1);
    assert.match(receipts[0].requestHash, /^[a-f0-9]{64}$/);
    assert.equal(receipts[0].model, "receipt");
    assert.equal(receipts[0].runId, (await app.rpc("status")).value.runId);
    const verify = await promisify(execFile)(process.execPath, [
      "scripts/verify.mjs",
      "--runtime",
      app.runtime,
      "--session",
      id,
    ]);
    assert.equal(JSON.parse(verify.stdout).durableSnapshotVerified, true);
    await app.stop();
    await app.start();
    assert.equal((await app.rpc("status")).value.authenticated, false);
    const restored = await readSession(app.runtime, id);
    assert.deepEqual(restored, rows);
    assert.deepEqual(JSON.parse(await readFile(archivePath, "utf8")), archive);
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        "scripts/verify.mjs",
        "--runtime",
        app.runtime,
        "--session",
        id,
        "--require-live",
      ]),
      (error) => error.stderr.includes("FRESH_GEA_LOGIN_REQUIRED"),
    );
  },
);

test(
  "a failed submission can retry the same preview after storage recovers",
  { timeout: 60000 },
  async (t) => {
    const app = await receiptProfile(t);
    await app.login();
    const page = (await app.rpc("plans")).value;
    const preview = (
      await app.rpc("prepare", {
        queryId: page.queryId,
        planId: page.records[0].planId,
      })
    ).value;
    const storage = app.runtime + "/home/sessions";
    await mkdir(storage, { recursive: true });
    await rename(storage, storage + ".saved");
    await writeFile(storage, "temporarily unavailable");
    const failed = await app.rpc("submit", { previewId: preview.previewId });
    await unlink(storage);
    await rename(storage + ".saved", storage);
    assert.equal(failed.ok, false);
    const retry = await app.rpc("submit", { previewId: preview.previewId });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    const rows = await until(
      () => readSession(app.runtime, retry.value.sessionId),
      (rows) => rows.some((row) => row.type === "turn/end"),
    );
    const messages = rows.filter((row) => row.type === "user/message");
    assertReceiptMessages(rows, app.receiptCore);
    assert.equal(messages.filter((row) => row.data.source.kind === "gea-proof").length, 1);
  },
);
