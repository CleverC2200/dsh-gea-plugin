import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { profile } from "../profile.mjs";

// Independent metadata from the registered Workbench/Manage resource headers and
// GenUI's public provider declaration. Local filesystem roots are owned below.
const expectedEntries = [
  {
    name: "category-plan",
    description: "本地模拟品类计划快照与交互，不代表真实业务结果。",
  },
  {
    name: "genui",
    description:
      "GenUI dsh-ui component/schema reference. Preserve conversation language for all user-visible text.",
  },
  {
    name: "inventory-apsplan",
    description: "解释产销协同当前经营页面的 GEA 只读指标、来源、范围和缺失项。",
  },
  {
    name: "inventory-aqkc",
    description:
      "基地库存页面的只读查询与风险分析：解释目标偏差、当前待发订单缺口、货龄和经营洞察，复用当前页面确定性结果。",
  },
  {
    name: "inventory-customer",
    description: "客户库存演示页面的业务范围与数据边界。",
  },
  {
    name: "inventory-dealer",
    description:
      "在 DSH 经销商库存业务页读取当前授权证据、调整筛选、解释指标，并在右侧 DSH 会话中整理分析方案。",
  },
  {
    name: "inventory-fc",
    description:
      "在 DSH 分仓库存业务页读取当前 GEA 证据、调整筛选、解释指标，并在右侧 DSH 会话中整理分析方案。",
  },
  {
    name: "inventory-mps",
    description: "解释MPS模拟原型当前页面的需求、滚动计划、产能与缺口",
  },
  {
    name: "inventory-orderfulfillment",
    description: "订单履约原型的模拟数据、筛选和引用范围。",
  },
  {
    name: "inventory-orderworkbench",
    description: "订单工作台页面的演示范围与数据边界。",
  },
  {
    name: "inventory-qll",
    description: "解读当前公司全链库存、趋势与缺口，核当前范围、缺失或拒权，并引用当前页面证据。",
  },
  {
    name: "plan-regional",
    description:
      "在区域计划原型当前页面解释模拟提报跟进、品类达成、复盘和异常，或按要求切换模块、维度及模拟日期。",
  },
  {
    name: "receipt-catalog-canary",
    description:
      "Receipt catalog metadata fixture; its body requires an explicit skill invocation.",
  },
  {
    name: "sales-forecast-result-analysis",
    description: "解读已有预测、比较计划版本或复盘历史偏差；不生成新预测或修改正式计划。",
  },
  {
    name: "sales-ops-problem-analysis",
    description: "已有产销指标异常，需要定位贡献对象、核查订单库存生产事件及改善措施时使用。",
  },
  {
    name: "sinian-demand-baseline",
    description:
      "要算数量基线或生成预测草案时加载：按字典 V2 的④⑤⑥公式计算客户 SKU 次月拉货数量基线，处理新品与节令口径缺口；只出草案，不做 DMS 回写。",
  },
  {
    name: "sinian-demand-dialogue",
    description:
      "需求预测对话的默认入口技能：用户在 GEA 会话里查/问需求预测、销售计划、提报或审批口径（例如“查一下 9 月需求预测的数据”）时先加载本技能，再按 V1.15 规则用只读数据作答、维护本地草稿并引导固定入口；不写回、不替用户点击最终提交。",
  },
  {
    name: "sinian-forecast-review",
    description:
      "要复核或要报告时加载：用户要求核对数据覆盖、公式证据、业务风险、可解释报告或离线回测口径时，用本技能逐项复核并整理交付；不执行审批、排产或写回。",
  },
  {
    name: "sinian-forecast-scope",
    description:
      "确认预测范围与口径时加载：用户问“这个月/这些客户/哪些 SKU 算在内、口径怎么定、实体怎么消歧”时，用本技能核对客户可售 SKU 范围与候选收缩；只做范围与数据准备，不执行预测或业务写入。",
  },
];
const bodyCanary = "RECEIPT_SKILL_BODY_MUST_NOT_AUTOLOAD_R39_6d341cbf";

/** Retain the business profile and give every filesystem Skill source a private root. */
export async function receiptProfile(t) {
  const { core } = JSON.parse(await readFile(process.env.GEA_TEST_CANDIDATE, "utf8"));
  assert.ok([rc2, alpha].includes(core), "Unsupported receipt Core input");
  const env = { GEA_WEB_LOGIN_PERSIST: "0" };
  const app = await profile(t, {
    env,
    async beforeStart({ runtime }) {
      env.HOME = join(runtime, "fixture-user-home");
      env.DSH_AGENTS_HOME = join(runtime, "fixture-agents-home");
      env.DSH_BUNDLED_SKILL_DIR = join(runtime, "fixture-bundled-skills");
      const skill = join(runtime, "home/skills/receipt-catalog-canary");
      await Promise.all(
        [env.HOME, env.DSH_AGENTS_HOME, env.DSH_BUNDLED_SKILL_DIR, skill].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      await writeFile(
        join(skill, "SKILL.md"),
        "---\nname: receipt-catalog-canary\ndescription: Receipt catalog metadata fixture; its body requires an explicit skill invocation.\n---\n" +
          bodyCanary +
          "\n",
        { flag: "wx" },
      );
    },
  });
  return Object.assign(app, { receiptCore: core });
}

/** A directory is durable metadata; it must not load Skill instructions or dispatch them. */
export function assertReceiptCatalog(rows) {
  const messages = rows.filter((row) => row.type === "user/message");
  const catalogs = messages.filter((row) => row.data.source.kind === "skill-catalog");
  assert.equal(catalogs.length, 1);
  assert.deepEqual(catalogs[0].data.source, {
    kind: "skill-catalog",
    form: "catalog",
    entries: expectedEntries,
  });
  assert.equal(
    messages.some((row) => row.data.source.kind === "skill-invocation"),
    false,
  );
  assert.equal(JSON.stringify(rows).includes(bodyCanary), false);
  const calls = rows
    .filter((row) => row.type === "assistant/message")
    .flatMap((row) => row.data.message.content)
    .filter((block) => block.type === "tool-call");
  assert.equal(
    calls.some((call) => ["skill", "skill_reference_read"].includes(call.name)),
    false,
  );
}

const rc2 = "639ed015397290b3745d163aafe02ffee4aa3f84";
const alpha = "5badb15009ae1756c3afe0ae0cef1faafc290ccc";

function assertSnapshot(source, names) {
  assert.deepEqual(Object.keys(source).sort(), ["form", "kind", "sections"]);
  assert.equal(source.form, "snapshot");
  assert.deepEqual(
    source.sections.map((section) => section.name),
    names,
  );
  for (const section of source.sections) {
    assert.deepEqual(Object.keys(section).sort(), ["name", "text"]);
    assert.equal(typeof section.text, "string");
    assert.ok(section.text.length > 0);
  }
}

/** Validate the Core-declared metadata and retain exactly one receipt proof. */
export function assertReceiptMessages(rows, core) {
  assert.ok([rc2, alpha].includes(core), "Unsupported receipt Core input");
  assertReceiptCatalog(rows);
  const messages = rows.filter((row) => row.type === "user/message");
  const proofs = [];
  const contexts = [];
  const times = [];
  for (const row of messages) {
    const source = row.data.source;
    switch (source.kind) {
      case "skill-catalog":
        break;
      case "runtime-context":
        assertSnapshot(source, ["sandbox:policy", "approval:policy"]);
        contexts.push(row);
        break;
      case "time-context":
        assert.equal(core, alpha, "time-context is declared only by alpha standard");
        assertSnapshot(source, ["time-context"]);
        times.push(row);
        break;
      case "gea-proof":
        assert.deepEqual(source, {
          kind: "gea-proof",
          form: "notice",
          summary: "已提交只读快照，正在验证数据传递",
        });
        proofs.push(row);
        break;
      default:
        assert.fail("Unsupported receipt user-message source: " + source.kind);
    }
  }
  assert.equal(contexts.length, 1, "Receipt must retain one runtime-context snapshot");
  assert.equal(
    times.length,
    core === alpha ? 1 : 0,
    "Receipt time metadata must match its Core declaration",
  );
  assert.equal(proofs.length, 1, "Receipt must retain exactly one business proof");
  return proofs;
}
