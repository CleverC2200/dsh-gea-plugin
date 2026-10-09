/** Public plugin/page grant fixture only. No listener, profile or external transport. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";
import { BUSINESS_MENU_PRESET, resolveBusinessMenu } from "../src/business-navigation.ts";
import { isHtmlPluginRetired } from "../src/html-plugin-selection.ts";
import { MockDmsWriteback } from "@cleverc2200/dsh-agent-workbench/dms-mock";

test("DMS is one mock prototype entry and the correction consumer uses the Workbench public model", async () => {
  assert.equal(isHtmlPluginRetired("inventory-dms", true, []), false);
  assert.equal(isHtmlPluginRetired("inventory-dms", true, ["inventory-dms"]), true);
  const entries = resolveBusinessMenu(
    BUSINESS_MENU_PRESET,
    new Map([["inventory-dms", "DMS 模拟"]]),
  )
    .filter((g) => g.key === "prototypes")
    .flatMap((g) => g.entries);
  assert.deepEqual(
    entries.map((e) => e.id),
    ["inventory-dms"],
  );
  assert.equal(entries[0].disabled, false);
  const model = new MockDmsWriteback(
    {
      planId: "z",
      versionId: "v",
      typeCode: "Y",
      orderType: "Z",
      status: 5,
      skus: [{ skuCode: "123", qty: "30", addQty: "2", cutQty: "0" }],
    },
    () => "2026-09-12T10:00:00.000Z",
  );
  model.deliver("partial");
  assert.equal(model.read().plan.status, 5);
  assert.throws(() => model.deliver("success"), /RECONCILE_FIRST/);
  model.reconcile();
  model.deliver("success");
  assert.equal(model.read().remoteDeliveries, 2);
  assert.deepEqual(
    model.read().packets.map((p) => p.items[0].qty),
    ["2.000", "0.000"],
  );
});

test("current DMS package registers one Manage resource and mock view grant rejects SQL before transport", async (t) => {
  const directory = resolve("../dsh-agent-workbench/lib/prototypes/dms");
  const manifest = JSON.parse(await readFile(resolve(directory, "plugin.json"), "utf8"));
  const effects = [],
    pages = [],
    resources = [],
    surfaces = new Map(),
    identities = new Map();
  const ctx = {
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") effects.push(cleanup);
      return cleanup;
    },
    connection: {
      fetch: {
        register() {
          return () => {};
        },
      },
    },
    agentResources: {
      async register(definitions) {
        resources.push(...definitions);
        return () => {
          resources.length = 0;
        };
      },
    },
    workbenchPages: {
      registerBusinessPage(definition, acquire) {
        pages.push({ definition, acquire });
        return () => {
          pages.length = 0;
        };
      },
    },
  };
  t.after(async () => {
    for (const cleanup of effects.reverse()) await cleanup();
  });
  let transports = 0;
  const business = {
    config: {},
    status: () => ({ authenticated: false }),
    pageSessionScope: () => undefined,
    pluginSql: () => {
      transports++;
      throw Error("Must not reach SQL");
    },
    htmlLaunch: () => {
      transports++;
      throw Error("Must not reach Gateway");
    },
    setSurface(session, value) {
      surfaces.set(session, value);
      return value;
    },
    surfaceFor: (session) => surfaces.get(session),
    clearSurface: (session) => surfaces.delete(session),
    touchPageIdentity: (session, value) => identities.set(session, value),
    currentPageIdentity: (session) => identities.get(session),
    clearPageIdentity: (session) => identities.delete(session),
  };
  const result = await registerHtmlPlugins(ctx, business, [
    { directory, manifest, htmlPath: resolve(directory, "index.html") },
  ]);
  assert.equal(resources.length, 1);
  assert.equal(resources[0].id, "gea-html-inventory-dms");
  assert.equal(resources[0].enabled, true);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].definition.id, "inventory-dms");
  assert.equal(pages[0].definition.resourceId, "gea-html-inventory-dms");
  assert.equal(result.capabilityContracts[0].data.mock, true);
  assert.equal(result.capabilityContracts[0].maxEffect, "view");
  const session = "session-11111111-1111-4111-8111-111111111111";
  const grant = await pages[0].acquire(
    session,
    "gea-html-inventory-dms",
    new AbortController().signal,
  );
  assert.equal(grant.access.mode, "mock");
  assert.equal(grant.access.trusted, false);
  assert.equal(grant.allowsEffect("view"), true);
  for (const effect of ["draft", "submit", "approve"])
    assert.equal(grant.allowsEffect(effect), false);
  await assert.rejects(
    grant.readSql({ sql: "SELECT 1" }, new AbortController().signal),
    /MOCK_DATA_ONLY/,
  );
  assert.equal(grant.workspace, undefined);
  assert.equal(transports, 0);
  grant.observe();
  assert.equal(identities.get(session).mock, true);
  grant.release();
  assert.equal(identities.has(session), false);
  assert.equal(surfaces.has(session), false);
});
