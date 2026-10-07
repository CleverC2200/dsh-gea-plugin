import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractFromPlugin } from "../src/capability/contract.ts";
import { readPluginContract } from "../src/capability/declarations.ts";
import { createCapabilityRegistry } from "../src/capability/registry.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-split-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = contractFromPlugin({
    id: "inventory-probe",
    label: "声明探针",
    consumerCode: "probe-consumer",
    pageIds: ["inventory-probe"],
    maxEffect: "view",
  });
  const page = {
    ...legacy.view,
    consumerCode: "probe-consumer",
    maxEffect: "view",
  };
  const { view, ...capability } = legacy;
  const declarations = { page: "page.json", capability: "capability.json" };
  const save = async () => {
    await writeFile(join(root, "page.json"), JSON.stringify(page));
    await writeFile(join(root, "capability.json"), JSON.stringify(capability));
  };
  await save();
  return { root, legacy, page, capability, declarations, save };
}

test("分离声明进入现有目录，页面关联与只读权限和旧声明相同", async (t) => {
  const f = await fixture(t);
  const split = await readPluginContract(f.root, f.declarations, f.legacy);
  await assert.rejects(readPluginContract(f.root, undefined, f.legacy), /UNSUPPORTED_HTML_RESOURCE_PROTOCOL/);
  const legacy = f.legacy;
  const registry = createCapabilityRegistry([split]);
  assert.deepEqual(
    registry.modules(),
    createCapabilityRegistry([legacy]).modules(),
  );
  assert.equal(registry.byConsumer("probe-consumer").id, "inventory-probe");
  assert.equal(registry.allows("gea-html-inventory-probe", "view"), true);
  assert.equal(registry.allows("gea-html-inventory-probe", "draft"), false);
  assert.match(split.source, /page.json.*capability.json/);
});

for (const [name, change, code] of [
  [
    "缺失能力引用",
    (f) => {
      f.declarations.capability = "missing.json";
    },
    /ENOENT.*source:.*missing.json/,
  ],
  [
    "缺失技能引用",
    (f) => {
      f.capability.skills = ["missing-skill"];
    },
    /MISSING_SKILL_REFERENCE.*source:/,
  ],
  [
    "缺失页面引用",
    (f) => {
      f.page.pageIds = ["inventory-missing"];
    },
    /MISSING_PAGE_REFERENCE.*source:/,
  ],
  [
    "重复页面 ID",
    (f) => {
      f.page.pageIds.push("inventory-probe");
    },
    /DUPLICATE_PAGE_ID.*source:/,
  ],
  [
    "非法影响等级",
    (f) => {
      f.capability.maxEffect = "superuser";
    },
    /INVALID_CAPABILITY_CONTRACT.*source:/,
  ],
  [
    "能力提权",
    (f) => {
      f.capability.maxEffect = f.page.maxEffect = "approve";
    },
    /INCOMPATIBLE_SPLIT_DECLARATION.*source:/,
  ],
  [
    "能力层提权",
    (f) => {
      f.capability.layers = ["approve"];
    },
    /INCOMPATIBLE_SPLIT_DECLARATION.*source:/,
  ],
  [
    "Consumer 不匹配",
    (f) => {
      f.page.consumerCode = "another-consumer";
    },
    /INCOMPATIBLE_SPLIT_DECLARATION.*source:/,
  ],
  [
    "混入页面声明",
    (f) => {
      f.capability.view = f.legacy.view;
    },
    /INCOMPATIBLE_SPLIT_DECLARATION.*source:/,
  ],
  [
    "隐式权限",
    (f) => {
      delete f.capability.maxEffect;
    },
    /INCOMPATIBLE_SPLIT_DECLARATION.*source:/,
  ],
])
  test(`分离声明拒绝${name}，诊断带来源`, async (t) => {
    const f = await fixture(t);
    change(f);
    await f.save();
    await assert.rejects(
      readPluginContract(f.root, f.declarations, f.legacy),
      code,
    );
  });

test("旧契约和新契约冲突时带双方来源拒绝，非法等级不进入白名单", async (t) => {
  const f = await fixture(t);
  const one = await readPluginContract(f.root, f.declarations, f.legacy);
  assert.throws(
    () =>
      createCapabilityRegistry([
        one,
        { ...f.legacy, source: "old/plugin.json" },
      ]),
    /DUPLICATE_CAPABILITY_CONTRACT.*page.json.*old\/plugin.json/,
  );
  assert.throws(
    () =>
      createCapabilityRegistry([
        one,
        { ...f.legacy, id: "inventory-other", source: "other/plugin.json" },
      ]),
    /DUPLICATE_CAPABILITY_SURFACE.*source:/,
  );
  assert.throws(
    () => createCapabilityRegistry([{ ...one, maxEffect: "unsafe" }]),
    /INVALID_CAPABILITY_EFFECT.*source:/,
  );
});

test("重复安装声明在发布 Skill、预设和路由之前被拒绝", async (t) => {
  const { registerHtmlPlugins } = await import("../src/html-plugins.ts");
  const { mkdir, readdir } = await import("node:fs/promises");
  const f = await fixture(t);
  await writeFile(
    join(f.root, "plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: f.legacy.id,
      name: f.legacy.label,
      html: "index.html",
      skills: ["SKILL.md"],
      mcp: "mcp.json",
      declarations: f.declarations,
      agentResources: {provider:"dsh-agent-manage",prompt:"prompt.json"},
      gea: {
        consumerCode: "probe-consumer",
        readonly: true,
        contract: "gea-html-v2",
      },
    }),
  );
  await writeFile(
    join(f.root, "mcp.json"),
    JSON.stringify({
      provider: "gea",
      transport: "host-provided",
      contract: "gea-html-v2",
      consumer: { consumerType: "AGENT", consumerCode: "probe-consumer" },
      capabilities: ["governed-sql-read"],
    }),
  );
  await writeFile(
    join(f.root, "index.html"),
    "<html><body>probe</body></html>",
  );
  await writeFile(
    join(f.root, "SKILL.md"),
    "---\nname: inventory-probe\ndescription: probe\n---\n",
  );
  await writeFile(join(f.root,"prompt.json"),JSON.stringify({consumerCode:"probe-consumer",persona:"只读探针",skills:["inventory-probe"]}));
  const runtimeDir = join(f.root, "runtime");
  await mkdir(runtimeDir);
  await assert.rejects(
    registerHtmlPlugins(
      {
        effect() {
          assert.fail("must not publish effects");
        },
      },
      { config: { runtimeDir } },
      await Promise.all([1, 2].map(async () => ({ directory: f.root, htmlPath: join(f.root, "index.html"), manifest: JSON.parse(await readFile(join(f.root, "plugin.json"), "utf8")) }))),
    ),
    /DUPLICATE_HTML_PLUGIN.*source:/,
  );
  assert.deepEqual(await readdir(runtimeDir), []);
});
