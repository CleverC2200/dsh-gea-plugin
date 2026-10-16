import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";

test("the installed base inventory Agent receives every declared P1 Skill through Manage", async (t) => {
  const directory = resolve("../dsh-agent-workbench/lib/business/inventory-aqkc");
  const manifest = JSON.parse(await readFile(resolve(directory, "plugin.json"), "utf8"));
  const expected = [
    "inventory-aqkc",
    "aging-stagnation-monitoring",
    "future-aging-projection",
    "inventory-deviation-monitoring",
    "inventory-policy",
    "report-templates",
    "shortage-monitoring",
  ];
  const cleanups = [];
  let definition;
  const ctx = {
    effect(fn) {
      const off = fn();
      if (typeof off === "function") cleanups.push(off);
    },
    agentResources: {
      async register(entries) {
        [definition] = entries;
        return () => {};
      },
    },
    connection: { fetch: { register: () => () => {} } },
    workbenchPages: { registerBusinessPage: () => () => {} },
  };
  t.after(async () => {
    for (const off of cleanups.reverse()) await off();
  });
  await registerHtmlPlugins(ctx, { status: () => ({ authenticated: false }) }, [
    { directory, manifest, htmlPath: resolve(directory, "index.html") },
  ]);
  assert.equal(definition.id, "gea-html-inventory-aqkc");
  assert.deepEqual(definition.profile.skills, expected);
  assert.deepEqual(Object.keys(definition.skillFiles), expected);
  assert.deepEqual(Object.values(definition.skillFiles), manifest.skills);
  for (const [name, file] of Object.entries(definition.skillFiles))
    assert.match(
      await readFile(resolve(directory, file), "utf8"),
      new RegExp("name: " + name + "\\s"),
    );
  const prompt = JSON.parse(await readFile(resolve(directory, definition.prompt), "utf8"));
  assert.deepEqual(prompt.skills, expected);
  assert.match(prompt.persona, /基地库存运营监控 Agent/);
});
