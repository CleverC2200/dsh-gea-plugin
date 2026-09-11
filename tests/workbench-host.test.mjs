import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "workbench reads fixed GEA resources and prepares fresh exact values under the current login",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    const planId = "9007199254740993";
    let amount = "12.3000";
    let incomplete = false;
    let expired = false;
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (!path.startsWith("/gea/sales-plan/")) return false;
      if (expired) {
        reply({ message: "Expired login" }, 401);
        return true;
      }
      if (path.endsWith("/periods")) {
        reply({
          success: true,
          result: {
            records: [
              { periodId: "period-1", tenantId: "0", periodMonth: "2026-09" },
            ],
            total: 3,
          },
        });
      } else if (path.endsWith("/plans")) {
        res.end(
          '{"success":true,"result":{"records":[{"planId":9007199254740993,"versionId":"version/a","dealerCode":9007199254740997,"dealer_name":"经销商A","province_name":"浙江","targetQty":0.1000,"currentAmount":9007199254740993.0100}],"total":11}}',
        );
      } else if (path.endsWith("/versions")) {
        reply({
          success: true,
          result: [{ id: "version/a", planId, seq: 1, targetAmount: amount }],
        });
      } else if (path.endsWith("/logs")) {
        res.end(
          '{"success":true,"result":{"records":[{"id":9007199254740999,"planId":"9007199254740993","versionId":"version/a","actionCode":"SAVE"}],"total":1}}',
        );
      } else if (path.endsWith("/skus")) {
        res.end(
          '{"success":true,"result":{"records":[{"id":9007199254740995,"versionId":"version/a","skuCode":"sku-a","qty":1.2000,"price":2.5000,"amt":3.0000,"amtBase":0.10}],"total":' +
            (incomplete ? 2 : 1) +
            "}}",
        );
      } else if (path.endsWith("/compare")) {
        res.end(
          '{"success":true,"result":{"records":[{"skuCode":"sku-a","changeType":"UPDATED","before":{"id":9007199254740995,"versionId":"version/a","skuCode":"sku-a","qty":0.0001,"amt":0.10},"after":{"id":9007199254740995,"versionId":"version/b","skuCode":"sku-a","qty":0.1001,"amt":9007199254740993.1100},"qtyDelta":0.1000,"amountDelta":9007199254740993.0100}],"total":1}}',
        );
      } else if (path.endsWith("/plans/" + planId)) {
        reply({
          success: true,
          result: {
            actionContext: {
              versionId: "version/a",
              status: 5,
              allowedActions: [],
              snapshotHash: "current-server-hash",
            },
            currentVersion: { id: "version/a", planId, targetAmount: amount },
            skus: { records: [], total: 0 },
            versions: { records: [{ id: "version/a", planId }], total: 1 },
            logs: [],
          },
        });
      } else return false;
      return true;
    });
    const query = (kind, query = {}) =>
      app.rpc("workbench/query", { kind, query });
    assert.equal((await query("list")).error.code, "LOGIN_REQUIRED");
    await app.login();

    await t.test(
      "page metadata, aliases and all seven read endpoints match the workbench API",
      async () => {
        const periods = await query("periods", {
          periodMonth: "2026-09",
          planType: "Y",
          status: "OPEN",
          pageNo: 2,
          pageSize: 2,
        });
        assert.equal(periods.ok, true, JSON.stringify(periods));
        assert.deepEqual(
          {
            total: periods.value.total,
            size: periods.value.size,
            current: periods.value.current,
            pages: periods.value.pages,
          },
          { total: 3, size: 2, current: 2, pages: 2 },
        );
        const page = await query("list", { periodId: "period-1", status: 5 });
        assert.equal(page.ok, true, JSON.stringify(page));
        assert.deepEqual(
          {
            total: page.value.total,
            size: page.value.size,
            current: page.value.current,
            pages: page.value.pages,
          },
          { total: 11, size: 10, current: 1, pages: 2 },
        );
        assert.equal(page.value.records[0].planId, planId);
        assert.equal(page.value.records[0].dealerCode, "9007199254740997");
        assert.equal(page.value.records[0].targetQty, "0.1000");
        assert.equal(
          page.value.records[0].currentAmount,
          "9007199254740993.0100",
        );
        assert.equal(page.value.records[0].dealerName, "经销商A");
        assert.equal(page.value.records[0].provinceName, "浙江");
        assert.equal(
          Object.hasOwn(page.value.records[0], "dealer_name"),
          false,
        );
        const detail = await query("detail", { planId });
        assert.equal(detail.value.currentVersion.targetAmount, "12.3000");
        assert.deepEqual(detail.value.skus, []);
        assert.equal(detail.value.versions[0].id, "version/a");
        assert.equal(
          detail.value.actionContext.snapshotHash,
          "current-server-hash",
        );
        assert.equal(
          (await query("versions", { planId })).value[0].id,
          "version/a",
        );
        assert.equal(
          (await query("logs", { planId })).value[0].id,
          "9007199254740999",
        );
        const skus = await query("versionSkus", { versionId: "version/a" });
        assert.equal(skus.value[0].id, "9007199254740995");
        assert.equal(skus.value[0].qty, "1.2000");
        assert.equal(skus.value[0].amt, "3.0000");
        assert.equal(skus.value[0].amtBase, "0.10");
        const compare = await query("compare", {
          planId,
          fromVersionId: "version/a",
          toVersionId: "version/b",
        });
        assert.equal(compare.value[0].qtyDelta, "0.1000");
        assert.equal(compare.value[0].amountDelta, "9007199254740993.0100");
        assert.equal(compare.value[0].after.amt, "9007199254740993.1100");
        const reads = app.requests.filter((req) =>
          req.url.pathname.startsWith("/gea/sales-plan/"),
        );
        assert.deepEqual(
          reads.map((req) => req.url.pathname),
          [
            "/gea/sales-plan/periods",
            "/gea/sales-plan/plans",
            `/gea/sales-plan/plans/${planId}`,
            `/gea/sales-plan/plans/${planId}/versions`,
            `/gea/sales-plan/plans/${planId}/logs`,
            "/gea/sales-plan/plans/versions/version%2Fa/skus",
            `/gea/sales-plan/plans/${planId}/compare`,
          ],
        );
        for (const req of reads) {
          assert.equal(req.method, "GET");
          assert.equal(req.body, "");
          assert.equal(req.headers["x-access-token"], "fixture-gea-token");
          assert.equal(req.headers["x-tenant-id"], "0");
        }
        assert.equal(reads[1].url.searchParams.get("pageNo"), "1");
        assert.equal(reads[1].url.searchParams.get("pageSize"), "10");
        assert.equal(
          reads.at(-1).url.searchParams.get("fromVersionId"),
          "version/a",
        );
        assert.equal(
          reads.at(-1).url.searchParams.get("toVersionId"),
          "version/b",
        );
      },
    );

    await t.test(
      "client routing, credentials and unrecognized fields never reach GEA",
      async () => {
        const count = app.requests.length;
        for (const payload of [
          { kind: "delete", query: { planId } },
          { kind: "list", query: {}, method: "POST" },
          { kind: "list", query: { url: "https://foreign.invalid" } },
          { kind: "list", query: { token: "client-owned" } },
          { kind: "list", query: { tenantId: "other" } },
          { kind: "versions", query: {} },
          { kind: "compare", query: { planId, fromVersionId: "version/a" } },
          { kind: "list", query: { pageSize: 1001 } },
        ]) {
          assert.equal(
            (await app.rpc("workbench/query", payload)).ok,
            false,
            JSON.stringify(payload),
          );
        }
        assert.equal(app.requests.length, count);
        incomplete = true;
        assert.equal(
          (await query("versionSkus", { versionId: "version/a" })).error.code,
          "GEA_INCOMPLETE_COLLECTION",
        );
        incomplete = false;
      },
    );

    await t.test(
      "preview re-reads current GEA details and a 401 invalidates both login and preview",
      async () => {
        amount = "99.9900";
        const before = app.requests.length;
        const prepared = await app.rpc("workbench/prepare", {
          planIds: [planId],
        });
        assert.equal(prepared.ok, true, JSON.stringify(prepared));
        assert.equal(
          prepared.value.snapshot.records[0].detail.currentVersion.targetAmount,
          "99.9900",
        );
        assert.equal(app.requests.length, before + 1);
        assert.equal(
          app.requests.at(-1).url.pathname,
          `/gea/sales-plan/plans/${planId}`,
        );
        assert.equal(app.requests.at(-1).method, "GET");
        assert.equal(
          (
            await app.rpc("workbench/prepare", {
              planIds: [planId],
              detail: { targetAmount: "injected" },
            })
          ).ok,
          false,
        );
        expired = true;
        assert.equal(
          (await query("detail", { planId })).error.code,
          "GEA_HTTP_401",
        );
        const expiredCount = app.requests.length;
        assert.equal((await query("list")).error.code, "LOGIN_REQUIRED");
        assert.equal(
          (await app.rpc("submit", { previewId: prepared.value.previewId }))
            .error.code,
          "LOGIN_REQUIRED",
        );
        assert.equal(app.requests.length, expiredCount);
      },
    );
  },
);

test(
  "a changed or failed workbench query invalidates prior analysis and mismatched GEA detail never becomes a snapshot",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    const planId = "9007199254740993";
    const detail = {
      currentVersion: { id: "version-1", planId, targetAmount: "12.3000" },
      versions: [{ id: "version-1", planId }],
      skus: [
        { id: "sku-1", versionId: "version-1", skuCode: "sku-a", qty: "1.000" },
      ],
      logs: [{ id: "log-1", planId, versionId: "version-1" }],
    };
    let response = detail;
    let failed = false;
    let detailGate;
    let detailStarted;
    app.route(async (request, res, reply) => {
      if (!request.url.pathname.endsWith("/plans/" + planId)) return false;
      if (detailGate) {
        detailStarted();
        await detailGate;
      }
      if (failed) reply({ message: "Read unavailable" }, 503);
      else reply({ success: true, result: response });
      return true;
    });
    await app.login();
    const prepare = () => app.rpc("workbench/prepare", { planIds: [planId] });
    const assertStale = async (preview) =>
      assert.equal(
        (await app.rpc("submit", { previewId: preview.previewId })).error?.code,
        "STALE_PREVIEW",
      );

    await t.test(
      "query and prepare failures cannot retain the preceding preview",
      async () => {
        const first = await prepare();
        assert.equal(first.ok, true, JSON.stringify(first));
        const invalidQuery = await app.rpc("workbench/query", {
          kind: "unsupported",
          query: {},
        });
        assert.equal(invalidQuery.ok, false);
        await assertStale(first.value);

        const second = await prepare();
        failed = true;
        assert.equal((await prepare()).error?.code, "GEA_HTTP_503");
        await assertStale(second.value);
        failed = false;

        const third = await prepare();
        assert.equal(
          (await app.rpc("workbench/prepare", { planIds: [] })).ok,
          false,
        );
        await assertStale(third.value);

        const fourth = await prepare();
        await app.rpc("workbench/query", { kind: "list", query: {} });
        await assertStale(fourth.value);
      },
    );

    await t.test(
      "every included resource retains its selected plan and version ownership",
      async () => {
        for (const invalid of [
          {
            ...detail,
            currentVersion: { ...detail.currentVersion, planId: "other-plan" },
          },
          { ...detail, versions: [{ id: "version-1", planId: "other-plan" }] },
          {
            ...detail,
            skus: [{ ...detail.skus[0], versionId: "other-version" }],
          },
          { ...detail, logs: [{ ...detail.logs[0], planId: "other-plan" }] },
          {
            ...detail,
            logs: [{ ...detail.logs[0], versionId: "other-version" }],
          },
        ]) {
          response = invalid;
          assert.equal(
            (await prepare()).error?.code,
            "GEA_IDENTITY_MISMATCH",
            JSON.stringify(invalid),
          );
        }
        response = detail;
        assert.equal((await prepare()).ok, true);
      },
    );

    await t.test(
      "a fresh query cancels a pending prepare before a late response can publish a preview",
      async () => {
        let release;
        detailGate = new Promise((resolve) => {
          release = resolve;
        });
        const started = new Promise((resolve) => {
          detailStarted = resolve;
        });
        const pending = prepare();
        try {
          await started;
          await app.rpc("workbench/query", { kind: "list", query: {} });
          release();
          assert.equal((await pending).ok, false);
        } finally {
          release();
          detailGate = undefined;
          detailStarted = undefined;
        }
        assert.equal((await prepare()).ok, true);
      },
    );
  },
);

test(
  "explicit workbench summary preserves selected current headers without silently truncating oversized details",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t, { config: { maxSnapshotBytes: 6000 } });
    const planId = "9007199254740993";
    const versionId = "9007199254740995";
    const dealerCode = "9007199254740997";
    let huge = true;
    let mismatch = false;
    let missingCurrent = false;
    let invalidSkuAmount;
    let reads = 0;
    app.route((req, res) => {
      if (req.url.pathname !== "/gea/sales-plan/plans/" + planId) return false;
      reads += 1;
      const result = {
        actionContext: {
          versionId,
          allowedActions: [],
          snapshotHash: "server-permission-context",
        },
        currentVersion: {
          id: versionId,
          planId,
          seq: 2,
          periodId: "period-1",
          planTypeCode: "Y",
          dealerCode,
          dealerName: "经销商A",
          orgName: "组织A",
          baseName: "华东",
          provinceName: null,
          areaName: "大区A",
          status: 5,
          effective: true,
          targetQty: "1.2300",
          targetAmount: "9007199254740993.0100",
          ...(missingCurrent
            ? {}
            : { currentQty: "2.3400", currentAmount: "9007199254740999.0200" }),
          additionalPayload: huge
            ? "UNSELECTED_ADDITIONAL_DATA".repeat(1000)
            : "small extra field",
        },
        skus: [
          {
            id: "sku-1",
            versionId: mismatch ? "foreign-version" : versionId,
            skuCode: "sku-a",
            qty: "1.2300",
            amt: "9007199254740993.0100",
            materialDescription: huge
              ? "UNSELECTED_SKU_DATA".repeat(1000)
              : "short description",
          },
          {
            id: "sku-2",
            versionId,
            skuCode: "sku-b",
            qty: "0.7700",
            amt: invalidSkuAmount === undefined ? "0.9900" : invalidSkuAmount,
          },
        ],
        versions: [{ id: versionId, planId }],
        logs: [
          {
            id: "log-1",
            planId,
            versionId,
            remark: huge ? "UNSELECTED_LOG_DATA".repeat(1000) : "short remark",
          },
        ],
      };
      let body = JSON.stringify({ success: true, result });
      for (const lexeme of [
        planId,
        versionId,
        dealerCode,
        "1.2300",
        "2.3400",
        "0.7700",
        "0.9900",
        "9007199254740993.0100",
        "9007199254740999.0200",
      ])
        body = body.replaceAll(JSON.stringify(lexeme), lexeme);
      res.end(body);
      return true;
    });
    await app.login();
    for (const payload of [
      { planIds: [planId] },
      { planIds: [planId], scope: "details" },
    ]) {
      const details = await app.rpc("workbench/prepare", payload);
      assert.equal(details.error?.code, "SNAPSHOT_TOO_LARGE");
    }
    assert.equal(reads, 2);
    const summary = await app.rpc("workbench/prepare", {
      planIds: [planId],
      scope: "summary",
    });
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.equal(reads, 3);
    assert.ok(summary.value.bytes <= summary.value.limitBytes);
    assert.equal(summary.value.limitBytes, 6000);
    const snapshot = summary.value.snapshot;
    assert.equal(snapshot.format, "gea-workbench-readonly-v1");
    assert.equal(snapshot.scope, "summary");
    assert.equal(snapshot.coverage, "selected-plans-current-summary");
    assert.equal(snapshot.records.length, 1);
    const record = snapshot.records[0];
    assert.equal(record.planId, planId);
    assert.equal(record.detail.currentVersion.id, versionId);
    assert.equal(record.detail.currentVersion.planId, planId);
    assert.equal(record.detail.currentVersion.dealerCode, dealerCode);
    assert.deepEqual(record.derivedTotals.quantity, {
      basis: "detail.skus[].qty",
      operation: "sum",
      recordCount: 2,
      value: "2",
    });
    assert.deepEqual(record.derivedTotals.amount, {
      basis: "detail.skus[].amt",
      operation: "sum",
      recordCount: 2,
      value: "9007199254740994",
    });
    assert.equal(record.detail.currentVersion.targetQty, "1.2300");
    assert.equal(
      record.detail.currentVersion.targetAmount,
      "9007199254740993.0100",
    );
    assert.equal(record.detail.currentVersion.currentQty, "2.3400");
    assert.equal(
      record.detail.currentVersion.currentAmount,
      "9007199254740999.0200",
    );
    assert.equal(
      Object.hasOwn(record.detail.currentVersion, "provinceName"),
      false,
    );
    assert.ok(record.missingFields.includes("provinceName"));
    assert.ok(record.missingFields.includes("orgCode"));
    assert.equal(record.missingFields.includes("currentAmount"), false);
    assert.deepEqual(Object.keys(record.detail), ["currentVersion"]);
    assert.equal(
      Object.hasOwn(record.detail.currentVersion, "additionalPayload"),
      false,
    );
    assert.ok(snapshot.missing.includes("sku-details-not-in-summary"));
    assert.ok(snapshot.missing.includes("historical-versions-not-in-summary"));
    assert.ok(snapshot.missing.includes("approval-logs-not-in-summary"));
    assert.equal(JSON.stringify(snapshot).includes("UNSELECTED_"), false);

    missingCurrent = true;
    const withoutCurrent = await app.rpc("workbench/prepare", {
      planIds: [planId],
      scope: "summary",
    });
    assert.equal(withoutCurrent.ok, true, JSON.stringify(withoutCurrent));
    assert.ok(
      withoutCurrent.value.snapshot.records[0].missingFields.includes(
        "currentQty",
      ),
    );
    assert.ok(
      withoutCurrent.value.snapshot.records[0].missingFields.includes(
        "currentAmount",
      ),
    );
    assert.equal(
      Object.hasOwn(
        withoutCurrent.value.snapshot.records[0].detail.currentVersion,
        "currentAmount",
      ),
      false,
    );
    for (const amount of [null, "unavailable", "1e1025"]) {
      invalidSkuAmount = amount;
      const unknownTotal = await app.rpc("workbench/prepare", {
        planIds: [planId],
        scope: "summary",
      });
      assert.equal(unknownTotal.ok, true, JSON.stringify(unknownTotal));
      const totals = unknownTotal.value.snapshot.records[0].derivedTotals;
      assert.equal(totals.quantity.value, "2");
      assert.equal(totals.amount.recordCount, 2);
      assert.equal(Object.hasOwn(totals.amount, "value"), false);
      assert.equal(
        totals.amount.missing,
        amount === "1e1025"
          ? "decimal-range-exceeded"
          : "decimal-source-unavailable",
      );
    }
    invalidSkuAmount = undefined;
    const beforeInvalid = reads;
    for (const scope of ["auto", "all", "", null, 0]) {
      assert.equal(
        (await app.rpc("workbench/prepare", { planIds: [planId], scope })).error
          ?.code,
        "INVALID_SELECTION",
      );
    }
    assert.equal(reads, beforeInvalid);
    mismatch = true;
    assert.equal(
      (
        await app.rpc("workbench/prepare", {
          planIds: [planId],
          scope: "summary",
        })
      ).error?.code,
      "GEA_IDENTITY_MISMATCH",
    );
    mismatch = false;
    huge = false;
    const complete = await app.rpc("workbench/prepare", {
      planIds: [planId],
      scope: "details",
    });
    assert.equal(complete.ok, true, JSON.stringify(complete));
    assert.equal(complete.value.snapshot.scope, "details");
    assert.equal(
      complete.value.snapshot.coverage,
      "selected-plans-current-detail",
    );
    assert.equal(
      complete.value.snapshot.records[0].detail.currentVersion
        .additionalPayload,
      "small extra field",
    );
    assert.equal(complete.value.snapshot.records[0].detail.skus.length, 2);
    assert.equal(complete.value.snapshot.records[0].detail.logs.length, 1);
  },
);
