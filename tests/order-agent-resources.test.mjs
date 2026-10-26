import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";

test("order and customer pages register their complete Agent profiles without widening capabilities", async (t) => {
  const definitions = new Map();
  const pages = new Map();
  const cleanups = [];
  const ctx = {
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    },
    agentResources: {
      async register(entries) {
        for (const entry of entries) definitions.set(entry.id, entry);
        return () => {
          for (const entry of entries) definitions.delete(entry.id);
        };
      },
    },
    connection: { fetch: { register: () => () => {} } },
    workbenchPages: {
      registerBusinessPage(page) {
        pages.set(page.id, page);
        return () => pages.delete(page.id);
      },
    },
  };
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  const packages = await Promise.all(
    ["orderworkbench", "orderfulfillment", "customer"].map(async (module) => {
      const directory = resolve(`../dsh-agent-workbench/lib/business/inventory-${module}`);
      return {
        directory,
        htmlPath: resolve(directory, "index.html"),
        manifest: JSON.parse(await readFile(resolve(directory, "plugin.json"), "utf8")),
      };
    }),
  );
  await registerHtmlPlugins(ctx, { status: () => ({ authenticated: false }) }, packages);
  for (const item of packages) {
    const definition = definitions.get("gea-html-" + item.manifest.id);
    assert.ok(definition, item.manifest.id);
    assert.equal(definition.enabled, true);
    const profile = JSON.parse(await readFile(resolve(item.directory, "prompt.json"), "utf8"));
    const capability = JSON.parse(
      await readFile(resolve(item.directory, "capability.json"), "utf8"),
    );
    assert.deepEqual(definition.profile.skills, profile.skills);
    assert.deepEqual(profile.skills, capability.skills);
    assert.equal(profile.skills.length, item.manifest.id === "inventory-customer" ? 6 : 11);
    assert.equal(definition.presetName, item.manifest.name + "Agent");
    assert.deepEqual(Object.keys(definition.skillFiles), profile.skills);
    assert.deepEqual(Object.values(definition.skillFiles), item.manifest.skills);
    for (const [name, file] of Object.entries(definition.skillFiles)) {
      const text = await readFile(resolve(item.directory, file), "utf8");
      assert.equal(text.match(/^name: (.+)$/m)?.[1].trim(), name);
    }
    assert.equal(pages.has(item.manifest.id), true);
    const reportStore = item.manifest.id === "inventory-orderworkbench";
    assert.equal(item.manifest.reportStore, reportStore ? "order" : undefined);
    assert.equal(item.manifest.gea.readonly, !reportStore);
    assert.equal(capability.maxEffect, reportStore ? "submit" : "view");
    assert.deepEqual(capability.layers, reportStore ? ["read", "draft", "submit"] : ["read"]);
    assert.equal(definition.profile.consumerCode, item.manifest.gea.consumerCode);
    assert.equal(definition.cube, true);
  }
});
