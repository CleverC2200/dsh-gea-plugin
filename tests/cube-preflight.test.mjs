// 出站预检闸门（规约 G3–G6 / §17）：能确定性判定的错误必须在本地拦下，不发请求。
// 用例按规约 §18 的反向清单组织：结构、单模型、成员类别、排序、分页、筛选、时间维度。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents:
      "export * from './src/host/cube-preflight.ts';\nexport * from './src/host/member-index.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const m = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);

const payload = {
  semanticModel: [
    {
      name: "agents_scm_branch_inventory_snapshot",
      dimensions: [
        { name: "agents_scm_branch_inventory_snapshot.id", type: "string" },
        { name: "agents_scm_branch_inventory_snapshot.warehouseid", type: "string" },
        { name: "agents_scm_branch_inventory_snapshot.available_qty", type: "number" },
        { name: "agents_scm_branch_inventory_snapshot.snapshot_date", type: "time" },
        // 文本年月列：值形如 2026-08，用 2026-10 过滤它是合法写法（不该被年月拦截误伤）。
        { name: "agents_scm_branch_inventory_snapshot.plan_month", type: "string" },
      ],
      measures: [],
      segments: [{ name: "agents_scm_branch_inventory_snapshot.latest_snapshot", type: "string" }],
    },
    {
      name: "agents_scm_inventory_age",
      dimensions: [
        { name: "agents_scm_inventory_age.id", type: "string" },
        // 线上实测：字符串日期被当成时间维度用（下游拒）。清单里类型是 string。
        { name: "agents_scm_inventory_age.productdate", type: "string" },
      ],
      measures: [],
    },
    {
      name: "agents_sales_shipment",
      dimensions: [{ name: "agents_sales_shipment.base_name", type: "string" }],
      measures: [{ name: "agents_sales_shipment.shipment_quantity", type: "number" }],
    },
  ],
};

const index = m.memberIndexFrom(payload);
const STOCK = "agents_scm_branch_inventory_snapshot";
const AGE = "agents_scm_inventory_age";

/** 只走形状校验（清单不在手）时用。 */
const shapeOnly = (parameters) => m.preflightCubeArguments(parameters);
/** 带成员清单：成员存在性与类别校验一起生效。 */
const withIndex = (parameters) => m.preflightCubeArguments(parameters, index);

const query = (name, cubeQuery) => ({ action: "query", queries: [{ name, query: cubeQuery }] });

test("正向：同模型的一项与两项查询都放行", () => {
  assert.equal(
    withIndex(
      query("inventory_sample", {
        dimensions: [`${STOCK}.id`, `${STOCK}.warehouseid`],
        order: { [`${STOCK}.id`]: "asc" },
        limit: 10,
      }),
    ),
    undefined,
  );
  assert.equal(
    withIndex({
      action: "query",
      queries: [
        { name: "a", query: { dimensions: [`${STOCK}.id`], limit: 5 } },
        { name: "b", query: { dimensions: [`${STOCK}.warehouseid`], limit: 5 } },
      ],
    }),
    undefined,
  );
  assert.equal(withIndex({ action: "inspect", queries: [] }), undefined);
});

test("G3 结构：空 queries、超过 8 项、name 重复或空白、缺 query 外壳、外层乱放字段", () => {
  assert.match(String(shapeOnly({ action: "query", queries: [] })), /GEA_CUBE_PREFLIGHT_BLOCKED/);
  assert.match(
    String(shapeOnly({ action: "query", queries: Array.from({ length: 9 }, (_, i) => ({ name: `q${i}`, query: { dimensions: [`${STOCK}.id`] } })) })),
    /最多 8 项/,
  );
  assert.match(
    String(shapeOnly({ action: "query", queries: [{ name: "x", query: { dimensions: [`${STOCK}.id`] } }, { name: "x", query: { dimensions: [`${STOCK}.id`] } }] })),
    /重复/,
  );
  assert.match(
    String(shapeOnly({ action: "query", queries: [{ name: "   ", query: { dimensions: [`${STOCK}.id`] } }] })),
    /name 不能为空/,
  );
  // 规约 §15 的原始形状错误：dimensions 直接放在 queries 元素里，没有 query 外壳。
  const flat = shapeOnly({ action: "query", queries: [{ name: "x", dimensions: [`${STOCK}.id`] }] });
  assert.match(String(flat), /query 必须是非空对象/);
  assert.match(String(flat), /形如|写成/);
  // 具名查询不允许额外字段；未知查询字段、显式 null 也不行。
  assert.match(
    String(shapeOnly({ action: "query", queries: [{ name: "x", query: { dimensions: [`${STOCK}.id`] }, limit: 5 }] })),
    /不允许额外字段 limit/,
  );
  assert.match(
    String(shapeOnly(query("x", { dimensions: [`${STOCK}.id`], order_by: "id" }))),
    /不认识的查询字段 order_by/,
  );
  assert.match(
    String(shapeOnly(query("x", { dimensions: [`${STOCK}.id`], filters: null }))),
    /不能传 null/,
  );
  // 只带分页、没有任何选择的空查询
  assert.match(String(shapeOnly(query("x", { limit: 10 }))), /至少要选一个/);
});

test("G3 inspect：带 queries 的 inspect 直接拦（inspect 必须 queries=[]）", () => {
  assert.match(
    String(shapeOnly({ action: "inspect", queries: [{ name: "x", query: { dimensions: [`${STOCK}.id`] } }] })),
    /inspect 时 queries 必须是空数组/,
  );
  assert.match(String(shapeOnly({ action: "cube_query", queries: [] })), /action=cube_query 不合法/);
});

test("G4 单模型：跨模型拦下并给出拆分方案，加 queries 项也绕不过去", () => {
  const hint = withIndex({
    action: "query",
    queries: [
      { name: "aqkc_zz_202610", query: { dimensions: [`${STOCK}.warehouseid`], limit: 10 } },
      { name: "age_zz_days", query: { dimensions: [`${AGE}.productdate`], limit: 10 } },
    ],
  });
  assert.match(String(hint), /出现了 2 个模型/);
  assert.match(String(hint), /拆成多次/);
  assert.match(String(hint), new RegExp(STOCK));
  assert.match(String(hint), new RegExp(AGE));
});

test("G4 单模型：同一个 query 里 dimensions 与 filters/order 用不同模型也要拦", () => {
  // 规约 §18 的"模型反向"用例：dimensions 来自 A，filters/order 来自 B。
  const viaFilter = withIndex(
    query("mixed", {
      dimensions: [`${STOCK}.warehouseid`],
      filters: [{ member: `${AGE}.id`, operator: "equals", values: ["1"] }],
      limit: 10,
    }),
  );
  assert.match(String(viaFilter), /出现了 2 个模型/);
  const viaOrder = withIndex(
    query("mixed", {
      dimensions: [`${STOCK}.warehouseid`],
      order: { [`${AGE}.id`]: "asc" },
      limit: 10,
    }),
  );
  assert.match(String(viaOrder), /出现了 2 个模型/);
});

test("接线：闸门在发送前调用，且清单不在手时先补读一次 inspect（G5）", async () => {
  // 这两个行为是"规约由调用层确定性执行"的落点，改别处很容易把它们丢掉，
  // 所以在源码层面钉一条。
  const source = await readFile("src/host/agent-tools.ts", "utf8");
  assert.match(source, /parameters\.action === "query" && !memberIndex\(\)/);
  assert.match(source, /await loadMemberIndex\(module, exec\.signal\)/);
  assert.match(source, /preflightCubeArguments\(parameters, memberIndex\(\)\)/);
  assert.ok(
    source.indexOf("preflightCubeArguments(parameters, memberIndex())") <
      source.indexOf("await module.call(toolName, parameters, exec.signal)"),
    "闸门必须在真正发送之前",
  );
  // 结构性缺口：已知取不到的组合要在发送前短路，且和被拒那次一样计入本轮总账。
  assert.match(source, /business\.cubeGaps\(\)\.find\(consumerCode, queriedModel\)/);
  assert.match(source, /availability: "known-gap"/);
  assert.match(source, /business\.cubeGaps\(\)\.note\(consumerCode, queriedModel/);
  assert.ok(
    source.indexOf('business.cubeGaps().find(consumerCode, queriedModel)') <
      source.indexOf("await module.call(toolName, parameters, exec.signal)"),
    "已知缺口必须在真正发送之前短路",
  );
});

test("G5 成员：不存在的成员拦下并给真名；维度不能进 measures；measures 上限按清单", () => {
  const unknown = withIndex(query("cat", { dimensions: [`${STOCK}.category_name`], limit: 20 }));
  assert.match(String(unknown), /GEA_CUBE_MEMBER_UNKNOWN/);
  // 数值维度（available_qty）写进 measures：这个模型没有度量，必须拦。
  const measure = withIndex(query("sum", { measures: [`${STOCK}.available_qty`], limit: 20 }));
  assert.match(String(measure), /GEA_CUBE_MEASURE_MISMATCH/);
  assert.match(String(measure), /dimensions/);
  // 反向：度量名写进 dimensions。
  const reverse = withIndex(query("dim", { dimensions: ["agents_sales_shipment.shipment_quantity"], limit: 20 }));
  assert.match(String(reverse), /是\*\*度量\*\*，不能放进 dimensions/);
  // 分段写进 dimensions 也不行。
  const segment = withIndex(query("seg", { dimensions: [`${STOCK}.latest_snapshot`], limit: 20 }));
  assert.match(String(segment), /是\*\*分段\*\*，不能放进 dimensions/);
});

test("G6 order：对象数组、大写方向、字符串方向都拦（一次列全同类问题）", () => {
  const objectArray = shapeOnly(
    query("x", { dimensions: [`${STOCK}.id`], order: [{ [`${STOCK}.id`]: "asc" }] }),
  );
  assert.match(String(objectArray), /二元数组/);
  const upper = shapeOnly(query("x", { dimensions: [`${STOCK}.id`], order: { [`${STOCK}.id`]: "ASC" } }));
  assert.match(String(upper), /方向 ASC 不合法/);
  const numeric = shapeOnly(query("x", { dimensions: [`${STOCK}.id`], order: [[`${STOCK}.id`, 1]] }));
  assert.match(String(numeric), /方向 1 不合法/);
  // 同类问题一次列全：两项查询的 order 都错时，两个 path 都要出现。
  const both = shapeOnly({
    action: "query",
    queries: [
      { name: "a", query: { dimensions: [`${STOCK}.id`], order: { [`${STOCK}.id`]: "ASC" } } },
      { name: "b", query: { dimensions: [`${STOCK}.id`], order: { [`${STOCK}.id`]: "DESC" } } },
    ],
  });
  assert.match(String(both), /queries\[0\]\.query\.order/);
  assert.match(String(both), /queries\[1\]\.query\.order/);
  // 正确写法放行
  assert.equal(
    shapeOnly(query("x", { dimensions: [`${STOCK}.id`], order: [[`${STOCK}.id`, "asc"], [`${STOCK}.id`, "desc"]] })),
    undefined,
  );
});

test("G6 limit/offset：字符串、0、超宿主保护上限都拦", () => {
  assert.match(String(shapeOnly(query("x", { dimensions: [`${STOCK}.id`], limit: "10" }))), /limit 必须是正整数/);
  assert.match(String(shapeOnly(query("x", { dimensions: [`${STOCK}.id`], limit: 0 }))), /limit 必须是正整数/);
  const tooBig = shapeOnly(query("x", { dimensions: [`${STOCK}.id`], limit: 5000 }));
  assert.match(String(tooBig), /宿主保护上限/);
  assert.match(String(tooBig), /分页/);
  assert.match(String(shapeOnly(query("x", { dimensions: [`${STOCK}.id`], offset: -1 }))), /offset/);
});

test("G6 filters：缺 values、缺 operator、and 与 member 混用、非数组都拦", () => {
  const noValues = shapeOnly(
    query("x", { dimensions: [`${STOCK}.id`], filters: [{ member: `${STOCK}.warehouseid`, operator: "equals" }] }),
  );
  assert.match(String(noValues), /缺 values/);
  const noOperator = shapeOnly(
    query("x", { dimensions: [`${STOCK}.id`], filters: [{ member: `${STOCK}.warehouseid`, values: ["W1"] }] }),
  );
  assert.match(String(noOperator), /没有 operator/);
  const mixed = shapeOnly(
    query("x", {
      dimensions: [`${STOCK}.id`],
      filters: [{ member: `${STOCK}.warehouseid`, and: [{ member: `${STOCK}.id`, operator: "equals", values: ["1"] }] }],
    }),
  );
  assert.match(String(mixed), /不能既带 member 又带 and\/or/);
  assert.match(String(shapeOnly(query("x", { dimensions: [`${STOCK}.id`], filters: "warehouse=W1" }))), /filters 必须是数组/);
  // set / notSet 本来就不带值，不能误伤
  assert.equal(
    shapeOnly(
      query("x", { dimensions: [`${STOCK}.id`], filters: [{ member: `${STOCK}.warehouseid`, operator: "notSet" }] }),
    ),
    undefined,
  );
  // 嵌套 or 的形状也要递归检查
  assert.match(
    String(
      shapeOnly(
        query("x", {
          dimensions: [`${STOCK}.id`],
          filters: [
            {
              or: [
                { member: `${STOCK}.warehouseid`, operator: "equals", values: ["W1"] },
                { member: `${STOCK}.warehouseid`, operator: "equals" },
              ],
            },
          ],
        }),
      ),
    ),
    /filters\[0\]\.or\[1\]\.values/,
  );
});

test("G5 时间维度：字符串日期不能当 timeDimensions，非时间成员一律拦", () => {
  const bad = withIndex(
    query("age", { timeDimensions: [{ dimension: `${AGE}.productdate`, dateRange: ["2026-09-01", "2026-09-23"] }] }),
  );
  assert.match(String(bad), /不是时间成员/);
  assert.match(String(bad), /没有时间成员|文本格式/);
  // 真时间成员放行
  assert.equal(
    withIndex(query("snap", { timeDimensions: [{ dimension: `${STOCK}.snapshot_date`, dateRange: ["2026-09-01", "2026-09-23"] }] })),
    undefined,
  );
  // dateRange 形状错
  assert.match(
    String(withIndex(query("snap", { timeDimensions: [{ dimension: `${STOCK}.snapshot_date`, dateRange: ["2026-09-23"] }] }))),
    /dateRange/,
  );
});

test("裸字段、物理表名、SQL 表达式都不是合法成员名", () => {
  for (const member of ["base_name", "*", "SUM(available_qty)"]) {
    const hint = withIndex(query("x", { dimensions: [member], limit: 10 }));
    assert.match(String(hint), /不是「模型\.字段」/, `member=${member}`);
  }
});

test("年月值：时间成员拦下并给正确写法，文本年月列放行", () => {
  // 时间成员（snapshot_date 声明 time）：年月值发出去会被数据库拒
  const blocked = withIndex(
    query("x", {
      dimensions: [`${STOCK}.id`],
      filters: [{ member: `${STOCK}.snapshot_date`, operator: "equals", values: ["2026-10"] }],
    }),
  );
  assert.match(String(blocked), /时间成员/);
  assert.match(String(blocked), /timeDimensions/);
  // 文本年月列（plan_month 声明 string，真实值就是 2026-08 这种）：不能拦
  assert.equal(
    withIndex(
      query("x", {
        dimensions: [`${STOCK}.id`],
        filters: [{ member: `${STOCK}.plan_month`, operator: "equals", values: ["2026-10"] }],
      }),
    ),
    undefined,
  );
  // 没有成员清单（类型未知）时也不拦——误拦代价更大
  assert.equal(
    shapeOnly(
      query("x", {
        dimensions: [`${STOCK}.id`],
        filters: [{ member: `${STOCK}.snapshot_date`, operator: "equals", values: ["2026-10"] }],
      }),
    ),
    undefined,
  );
});

test("清单不在手时只做形状校验，不编造成员结论", () => {
  // 没有清单：成员名对错判不了，但结构错误照样拦。
  assert.equal(shapeOnly(query("x", { dimensions: ["whatever.field"], limit: 10 })), undefined);
  assert.match(String(shapeOnly(query("x", { dimensions: [`${STOCK}.id`], limit: 0 }))), /limit 必须是正整数/);
});

test("§17.8 请求体字节：把整表列全的写法拦下，正常查询放行", () => {
  // 8 项 × 大量成员：字符数远超单次上限。
  const huge = {
    action: "query",
    queries: Array.from({ length: 8 }, (_, index) => ({
      name: `q${index}`,
      query: {
        dimensions: Array.from({ length: 120 }, (_, i) => `${STOCK}.column_name_number_${i}`),
        limit: 10,
      },
    })),
  };
  const hint = shapeOnly(huge);
  assert.match(String(hint), /超过单次上限/);
  assert.match(String(hint), /拆成多次调用/);
  // 正常规模（8 项 × 十几列）不受影响
  assert.equal(
    shapeOnly({
      action: "query",
      queries: Array.from({ length: 8 }, (_, index) => ({
        name: `q${index}`,
        query: { dimensions: [`${STOCK}.id`, `${STOCK}.warehouseid`], limit: 20 },
      })),
    }),
    undefined,
  );
});
