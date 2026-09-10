import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { profile, readSession, until } from "./profile.mjs";

test(
  "one preview submits once through the standard Session and survives a fresh process",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
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
    assert.equal(rows.filter((row) => row.type === "user/message").length, 1);
    assert.ok(
      JSON.stringify(rows.find((row) => row.type === "user/message")).includes(
        "1.2300",
      ),
    );
    assert.ok(
      JSON.stringify(
        rows.find((row) => row.type === "assistant/message"),
      ).includes(preview.snapshotHash),
    );
    assert.equal(JSON.stringify(rows).includes("fixture-gea-token"), false);
    const receipts = (await readFile(app.runtime + "/receipts.jsonl", "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].snapshotHash, preview.snapshotHash);
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
