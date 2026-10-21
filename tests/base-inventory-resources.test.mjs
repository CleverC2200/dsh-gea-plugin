import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, cp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";

for (const { id, source, expected, persona } of [
  {
    id: "inventory-aqkc",
    source: "business/inventory-aqkc",
    expected: [
      "inventory-aqkc",
      "aging-stagnation-monitoring",
      "future-aging-projection",
      "inventory-deviation-monitoring",
      "inventory-policy",
      "report-templates",
      "shortage-monitoring",
    ],
    persona: /基地库存运营监控 Agent/,
  },
  {
    id: "inventory-customer",
    source: "prototypes/inventory-customer",
    expected: [
      "inventory-customer",
      "customer-inventory-age-risk",
      "customer-inventory-change",
      "customer-inventory-diagnosis",
      "customer-overstock-control",
      "customer-stockout-replenishment",
    ],
    persona: /客户库存\s*Agent/,
  },
])
  test(`the ${id} declaration passes its original Consumer and Skills to Manage`, async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "gea-base-resources-")));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await cp(resolve("../dsh-agent-manage/business-resources", id), directory, {
      recursive: true,
    });
    for (const file of ["plugin.json", "page.json"])
      await cp(resolve("../dsh-agent-workbench", source, file), resolve(directory, file));
    await writeFile(resolve(directory, "index.html"), "<!doctype html><title>基地库存</title>");
    const manifest = JSON.parse(await readFile(resolve(directory, "plugin.json"), "utf8"));
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
    assert.equal(definition.id, "gea-html-" + id);
    assert.equal(definition.profile.consumerCode, manifest.gea.consumerCode);
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
    assert.match(prompt.persona, persona);
  });
