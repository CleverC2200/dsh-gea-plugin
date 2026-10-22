import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";
import { profileFor } from "../src/host/prompt-policy.ts";

test("a stale identity blocks its page while identity transport and current resources stay mounted", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gea-resource-upgrade-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "orderfulfillment");
  await cp(resolve("../dsh-agent-workbench/lib/business/inventory-orderfulfillment"), directory, {
    recursive: true,
  });
  const manifest = JSON.parse(await readFile(join(directory, "plugin.json"), "utf8"));
  manifest.mode = "mock";
  manifest.gea.consumerCode = "orderfulfillment-preview";
  const mcp = JSON.parse(await readFile(join(directory, manifest.mcp), "utf8"));
  mcp.consumer.consumerCode = manifest.gea.consumerCode;
  mcp.capabilities = [];
  await writeFile(join(directory, manifest.mcp), JSON.stringify(mcp));
  const customer = resolve("../dsh-agent-workbench/lib/business/inventory-customer");
  const packages = [
    { directory, htmlPath: join(directory, "index.html"), manifest },
    {
      directory: customer,
      htmlPath: join(customer, "index.html"),
      manifest: JSON.parse(await readFile(join(customer, "plugin.json"), "utf8")),
    },
  ];
  const { ctx, definitions, pages, routes, warnings } = registrationContext(t);
  const policy = profileFor("gea-html-inventory-orderfulfillment");
  const business = { status: () => ({ authenticated: false }), pageSessionScope: () => undefined };
  const registered = await registerHtmlPlugins(ctx, business, packages);
  assert.equal(profileFor("gea-html-inventory-orderfulfillment"), policy);
  assert.equal(policy.consumerCode, "order01");
  assert.equal(definitions.has("gea-html-inventory-orderfulfillment"), false);
  assert.equal(definitions.has("gea-html-inventory-customer"), true);
  assert.equal(
    registered.capabilityContracts.some((row) => row.id === manifest.id),
    false,
  );
  assert.equal(warnings.length, 1);
  await assert.rejects(
    pages.get(manifest.id)(
      "session-11111111-1111-4111-8111-111111111111",
      "gea-html-" + manifest.id,
      new AbortController().signal,
    ),
    /配套插件版本不兼容.*Workbench.*重启/,
  );
  const identity = await routes
    .get("/api/gea-html/identity")
    .fetch(new Request("http://localhost/api/gea-html/identity"));
  assert.equal(identity.status, 200);
  assert.equal((await identity.json()).status.authenticated, false);
  const compatibility = await routes
    .get("/api/gea-html/compatibility")
    .fetch(new Request("http://localhost/api/gea-html/compatibility"));
  assert.deepEqual(await compatibility.json(), [
    { id: manifest.id, code: "INVALID_AGENT_RESOURCE_IDENTITY" },
  ]);
});

function registrationContext(t) {
  const definitions = new Map(),
    pages = new Map(),
    routes = new Map(),
    cleanups = [],
    warnings = [];
  const ctx = {
    effect(fn) {
      const off = fn();
      if (typeof off === "function") cleanups.push(off);
    },
    logger: { warn: (...args) => warnings.push(args) },
    agentResources: {
      async register(entries) {
        for (const row of entries) definitions.set(row.id, row);
        return () => {
          for (const row of entries) definitions.delete(row.id);
        };
      },
    },
    workbenchPages: {
      registerBusinessPage(page, authorize) {
        pages.set(page.id, authorize);
        return () => pages.delete(page.id);
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
  };
  t.after(async () => {
    for (const off of cleanups.reverse()) await off();
  });
  return { ctx, definitions, pages, routes, warnings };
}

test("current MPS SQL and Cube read declarations are accepted while unknown or duplicate abilities are rejected", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gea-current-mps-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(resolve("../dsh-agent-workbench/lib/static/mps"), root, { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
  const mcp = JSON.parse(await readFile(join(root, manifest.mcp), "utf8"));
  assert.deepEqual(mcp.capabilities, ["governed-sql-read", "governed-cube-read"]);
  const packages = [{ directory: root, htmlPath: join(root, "index.html"), manifest }];
  const business = { status: () => ({ authenticated: false }), pageSessionScope: () => undefined };
  const valid = registrationContext(t);
  const result = await registerHtmlPlugins(valid.ctx, business, packages);
  assert(valid.definitions.has("gea-html-inventory-mps"));
  assert(result.capabilityContracts.some((row) => row.id === "inventory-mps"));
  for (const capabilities of [
    ["governed-sql-read", "business-write"],
    ["governed-sql-read", "governed-sql-read"],
    ["governed-cube-read"],
  ]) {
    await writeFile(join(root, manifest.mcp), JSON.stringify({ ...mcp, capabilities }));
    const invalid = registrationContext(t);
    await assert.rejects(
      registerHtmlPlugins(invalid.ctx, business, packages),
      /INVALID_GEA_CAPABILITY/,
    );
    assert.equal(invalid.definitions.size, 0);
  }
});
