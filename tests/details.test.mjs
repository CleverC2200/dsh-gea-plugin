import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { profile, readSession, until } from "./profile.mjs";

test(
  "selected historical version and explicit SKU subset remain distinct from current plan detail",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    const planId = "9007199254740993";
    const versions = [
      { id: "version-1", planId, seq: 2, status: 5, targetQty: "2.3400" },
      { id: "version-0", planId, seq: 1, status: 0, targetQty: "1.1100" },
    ];
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/plans")) {
        res.end(
          '{"success":true,"result":{"records":[{"planId":9007199254740993,"versionId":"version-1","periodId":20260901,"planTypeCode":"Y","orderType":"M","dealerCode":9007199254740997,"status":5,"targetQty":2.3400,"targetAmount":12.30,"currentQty":1.2300,"currentAmount":10.10}],"total":1,"current":1,"size":200,"pages":1}}',
        );
        return true;
      }
      if (path.endsWith("/plans/" + planId)) {
        reply({
          success: true,
          result: { currentVersion: versions[0], versions, logs: [] },
        });
        return true;
      }
      if (path.endsWith("/versions")) {
        reply({ success: true, result: versions });
        return true;
      }
      if (path.endsWith("/version-0/skus")) {
        res.end(
          '{"success":true,"result":{"records":[{"id":9007199254740995,"versionId":"version-0","skuCode":"sku-a","skuname":"黑芝麻汤圆","qty":1.2000,"price":2.5000,"amt":3.0000,"amtBase":0.10},{"id":"sku-b-id","versionId":"version-0","skuCode":"sku-b","qty":0.0010}],"total":5}}',
        );
        return true;
      }
    });
    await app.login();
    const periods = await app.rpc("periods");
    assert.equal(periods.value.records[0].periodMonth, "2026-09");
    const page = (
      await app.rpc("plans", { periodId: "20260901", status: "5", pageNo: 1 })
    ).value;
    const selection = { queryId: page.queryId, planId };
    const detail = await app.rpc("detail", selection);
    assert.equal(detail.ok, true, JSON.stringify(detail));
    assert.equal(detail.value.currentVersion.id, "version-1");
    assert.equal(
      (await app.rpc("versions", selection)).value.records[1].id,
      "version-0",
    );
    const sku = await app.rpc("skus", { ...selection, versionId: "version-0" });
    assert.equal(sku.value.records[0].qty, "1.2000");
    assert.equal(sku.value.records[0].amt, "3.0000");
    assert.equal(sku.value.records[0].materialDescription, "黑芝麻汤圆");
    assert.equal(sku.value.coverage, "partial");
    const prepared = await app.rpc("prepare", {
      ...selection,
      includeDetail: true,
      versionId: "version-0",
      skuIds: ["9007199254740995"],
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const snapshot = prepared.value.snapshot;
    assert.equal(snapshot.detail.currentVersion.id, "version-1");
    assert.equal(snapshot.version.record.id, "version-0");
    assert.equal(snapshot.skus.records.length, 1);
    assert.equal(snapshot.skus.total, 5);
    assert.equal(snapshot.skus.returned, 2);
    assert.equal(snapshot.skus.records[0].amtBase, "0.10");
    assert.ok(
      snapshot.skus.missingFields["9007199254740995"].includes("baseQty"),
    );
    const submit = await app.rpc("submit", {
      previewId: prepared.value.previewId,
    });
    const rows = await until(
      () => readSession(app.runtime, submit.value.sessionId),
      (rows) => rows.some((row) => row.type === "turn/end"),
    );
    const archivePath = `${app.runtime}/analysis-snapshots/${submit.value.sessionId}.json`;
    const archive = JSON.parse(await readFile(archivePath, "utf8"));
    assert.equal(archive.schema, 1);
    assert.equal(archive.sessionId, submit.value.sessionId);
    assert.deepEqual(archive.snapshot, snapshot);
    assert.equal(archive.snapshot.skus.records[0].amt, "3.0000");
    assert.equal(archive.snapshotHash, prepared.value.snapshotHash);
    assert.equal(createHash("sha256").update(JSON.stringify(archive.snapshot, null, 2)).digest("hex"), archive.snapshotHash);
    assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
    const notice = rows.find(row => row.type === "user/message" && (row.data.source.kind === "gea-proof" || row.data.source.plugin === "gea-proof"));
    assert.ok(notice);
    assert.equal(JSON.stringify(notice).includes(archive.snapshotHash), false);
    assert.equal(
      (await app.rpc("skus", { ...selection, versionId: "foreign-version" }))
        .error.code,
      "INVALID_VERSION",
    );
    assert.equal(
      (
        await app.rpc("prepare", {
          ...selection,
          versionId: "version-1",
          skuIds: ["9007199254740995"],
        })
      ).error.code,
      "SKUS_NOT_FETCHED",
    );
  },
);
