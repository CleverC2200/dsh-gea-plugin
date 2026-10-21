import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";

const session = "session-11111111-1111-4111-8111-111111111111";
test("the received packages preserve governed customer login and mock view-only grants", async (t) => {
  const definitions = new Map(),
    pages = new Map(),
    cleanups = [];
  const surfaces = new Map(),
    identities = new Map();
  const ctx = {
    effect(fn) {
      const off = fn();
      if (typeof off === "function") cleanups.push(off);
    },
    agentResources: {
      async register(entries) {
        for (const entry of entries) definitions.set(entry.id, entry);
        return async () => {
          for (const entry of entries) definitions.delete(entry.id);
        };
      },
    },
    connection: { fetch: { register: () => () => {} } },
    workbenchPages: {
      registerBusinessPage(page, authorize) {
        pages.set(page.id, authorize);
        return () => pages.delete(page.id);
      },
    },
  };
  const business = {
    status: () => ({ authenticated: false }),
    pageSessionScope: () => undefined,
    setSurface(id, value) {
      surfaces.set(id, value);
      return value;
    },
    surfaceFor: (id) => surfaces.get(id),
    clearSurface: (id) => surfaces.delete(id),
    touchPageIdentity: (id, value) => identities.set(id, value),
    currentPageIdentity: (id) => identities.get(id),
    clearPageIdentity: (id) => identities.delete(id),
    htmlLaunch() {
      assert.fail("mock must not launch a Consumer");
    },
    pluginSql() {
      assert.fail("mock must not read SQL");
    },
  };
  const packages = await Promise.all(
    ["customer", "orderworkbench", "orderfulfillment"].map(async (suffix) => {
      const directory = resolve("../dsh-agent-workbench/lib/business/inventory-" + suffix);
      return {
        directory,
        htmlPath: resolve(directory, "index.html"),
        manifest: JSON.parse(await readFile(resolve(directory, "plugin.json"), "utf8")),
      };
    }),
  );
  const dispose = async () => {
    for (const off of cleanups.splice(0).reverse()) await off();
  };
  t.after(dispose);
  await registerHtmlPlugins(ctx, business, packages);
  for (const item of packages) {
    const id = "gea-html-" + item.manifest.id,
      definition = definitions.get(id);
    assert.equal(definition.enabled, true);
    const capability = JSON.parse(
      await readFile(resolve(item.directory, "capability.json"), "utf8"),
    );
    assert.deepEqual(definition.profile.skills, capability.skills);
    const persona = JSON.parse(await readFile(resolve(definition.root, definition.prompt), "utf8"));
    assert.equal(persona.consumerCode, definition.profile.consumerCode);
    if (item.manifest.mode !== "mock") {
      assert.equal(item.manifest.gea.readonly, true);
      assert.equal(definition.cube, true);
      if (item.manifest.id === "inventory-customer") {
        assert.match(persona.persona, /GEA受控读取/);
        assert.match(persona.persona, /当前只读/);
      }
      await assert.rejects(
        pages.get(item.manifest.id)(session, id, new AbortController().signal),
        /PAGE_REFERENCE_LOGIN_REQUIRED/,
      );
      continue;
    }
    assert.match(persona.persona, /模拟/);
    const grant = await pages.get(item.manifest.id)(session, id, new AbortController().signal);
    assert.equal(grant.access.mode, "mock");
    assert.equal(grant.allowsEffect("view"), true);
    for (const effect of ["draft", "submit", "approve"])
      assert.equal(grant.allowsEffect(effect), false);
    await assert.rejects(grant.readSql({}, new AbortController().signal), /MOCK_DATA_ONLY/);
    assert.equal(grant.workspace, undefined);
    grant.release();
  }
  await dispose();
  assert.equal(definitions.size, 0);
  assert.equal(pages.size, 0);
  assert.equal(surfaces.size, 0);
});
