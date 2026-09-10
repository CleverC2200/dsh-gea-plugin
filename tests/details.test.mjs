import test from "node:test";
import assert from "node:assert/strict";
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
          '{"success":true,"result":{"records":[{"id":9007199254740995,"versionId":"version-0","skuCode":"sku-a","qty":1.2000,"price":2.5000,"amt":3.0000,"amtBase":0.10},{"id":"sku-b-id","versionId":"version-0","skuCode":"sku-b","qty":0.0010}],"total":5}}',
        );
        return true;
      }
    });
    await app.login();
    const periods = await app.rpc("periods");
    assert.equal(periods.value.records[0].periodMonth, "2026-09");
    const page = (
      await app.rpc("plans", { periodId: "period-1", status: "5", pageNo: 1 })
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
    assert.ok(
      JSON.stringify(rows.find((row) => row.type === "user/message")).includes(
        "3.0000",
      ),
    );
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
