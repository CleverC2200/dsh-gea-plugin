import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readConfiguredHtmlQuery } from "../src/host/configured-html-query.ts";

test("fulfillment installed queries bind order01 and reject browser Consumer/SQL overrides", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fulfillment-order01-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile(
      "../dsh-agent-workbench/prototypes/inventory-orderfulfillment/plugin.json",
      "utf8",
    ),
  );
  const policy = JSON.parse(await readFile('presets/execution-policy.json', 'utf8'));
  const capability = JSON.parse(await readFile('../dsh-agent-manage/business-resources/inventory-orderfulfillment/capability.json', 'utf8'));
  assert.equal(policy.profiles['gea-html-inventory-orderfulfillment'].consumerCode, manifest.gea.consumerCode);
  assert.deepEqual(policy.profiles['gea-html-inventory-orderfulfillment'].skills, capability.skills);
  assert.equal(manifest.skills.length, capability.skills.length);
  await writeFile(
    join(directory, "sql.config.json"),
    await readFile(
      "../dsh-agent-workbench/business/inventory-orderfulfillment/sql.config.json",
      "utf8",
    ),
  );
  const calls = [];
  const business = {
    pluginSql: async (request, signal, configured) => {
      signal.throwIfAborted();
      calls.push({ request, configured });
      return {
        rows: [{ order_no: "AUTHORIZED" }],
        returnedColumns: ["order_no"],
        rejectedColumns: [{ alias: "customer_name" }],
      };
    },
  };
  const parameters = {
    start: "2026-10-20",
    end_exclusive: "2026-10-21",
    base: null,
    region: null,
    province: null,
    sales_group: null,
    channel: null,
    customer: null,
    order: null,
    sku: null,
    carrier: null,
    page_size: 20,
    offset: 0,
  };
  const resource = { directory, manifest };
  const signal = new AbortController().signal;
  const result = await readConfiguredHtmlQuery(
    resource,
    { queryId: "orders.detail", parameters },
    business,
    signal,
  );
  assert.equal(result.success, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.consumerCode, "order01");
  assert.equal(calls[0].configured, true);
  assert.deepEqual(result.rejectedColumns, [{ alias: "customer_name" }]);
  assert.match(result.configVersion, /^[a-f0-9]{64}$/);
  for (const extra of [{ consumerCode: "other" }, { sql: "SELECT 1" }]) {
    const denied = await readConfiguredHtmlQuery(
      resource,
      { queryId: "orders.detail", parameters, ...extra },
      business,
      signal,
    );
    assert.equal(denied.errorCode, "INVALID_CONFIGURED_QUERY");
  }
  assert.equal(calls.length, 1);
});
