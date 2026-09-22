/**
 * 只读配方：把"这类问题该怎么查"从模型手里收回到契约里。
 *
 * 线上现象：模型靠 `describe` 能拿到真实表名与字段名，也会自己拼 SQL，但拼出来的
 * 语句在与网关的受控契约对齐时不可靠——一轮里连试二十多次、最后整轮空答
 * （`GEA_MODEL_EMPTY_RESPONSE`）。根因不是它不知道表名，而是它每次都在重写
 * 一份"口径 + 连接 + 过滤"都正确的大查询。
 *
 * 所以：常见问题在契约里登记成一条**已用真机验证过**的只读配方，工具按 id 直接执行，
 * 模型不必写 SQL；只有配方覆盖不到的临时问题才让它自己拼（并给它 describe 与失败提示）。
 *
 * 这里是临时来源（随模块自述落地后退化成兜底，见文档 §水平切片）：配方 SQL 一律
 * 只读、参数化、不写 LIMIT/OFFSET（分页由宿主统一加）。
 */

export type CapabilityRecipeParam = {
  name: string;
  description: string;
  /** 省略表示可选；必填参数缺失时工具直接报可读错误，不会拼出半截 SQL。 */
  required?: boolean;
};

export type CapabilityRecipe = {
  id: string;
  /** 一句话说明这条配方回答什么问题（进工具说明，模型靠它对上用户的话）。 */
  title: string;
  sql: string;
  params?: CapabilityRecipeParam[];
};

/** 按基地 + 品类/物料关键字汇总需求与缺货（近一次快照的待分配缺口口径）。 */
const shortageByBaseAndGroup: CapabilityRecipe = {
  id: "shortage-by-base-and-group",
  title: "按基地和品类/物料关键字汇总需求量与缺货量（最新快照）",
  params: [
    { name: "base", description: "基地名，模糊匹配，例如 %郑州%", required: true },
    { name: "group", description: "品类或物料关键字，模糊匹配，例如 %冷鲜肉水饺%", required: true },
  ],
  sql: [
    "SELECT belong_base_final AS base,",
    "       SUM(need_qty_origin) AS need_total,",
    "       SUM(outqty) AS shortage_total,",
    "       COUNT(DISTINCT new_material_code) AS sku_count,",
    "       CAST(MAX(snapshot_date) AS TEXT) AS snapshot",
    "FROM agents_scm_order_fulfillment",
    "WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM agents_scm_order_fulfillment)",
    "  AND (order_qty_origin > 0 OR need_qty_origin > 0)",
    "  AND belong_base_final LIKE :base",
    "  AND material_group_name LIKE :group",
    "GROUP BY belong_base_final",
  ].join("\n"),
};

/** 按物料逐条列出需求与缺货，用于"哪几个品缺得多"。 */
const shortageByMaterial: CapabilityRecipe = {
  id: "shortage-by-material",
  title: "按物料列出需求量与缺货量（同一基地/品类口径，缺货从多到少）",
  params: [
    { name: "base", description: "基地名，模糊匹配，例如 %郑州%", required: true },
    { name: "group", description: "品类或物料关键字，模糊匹配，例如 %冷鲜肉水饺%", required: true },
  ],
  sql: [
    "SELECT belong_base_final AS base,",
    "       new_material_code AS material_code,",
    "       new_material_name AS material_name,",
    "       SUM(need_qty_origin) AS need_total,",
    "       SUM(outqty) AS shortage_total",
    "FROM agents_scm_order_fulfillment",
    "WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM agents_scm_order_fulfillment)",
    "  AND (order_qty_origin > 0 OR need_qty_origin > 0)",
    "  AND belong_base_final LIKE :base",
    "  AND material_group_name LIKE :group",
    "GROUP BY belong_base_final, new_material_code, new_material_name",
    "ORDER BY shortage_total DESC",
  ].join("\n"),
};

/**
 * 库存/订单履约类模块共用同一批受管表（`agents_scm_order_fulfillment` 等），
 * 所以同一份配方在这些 consumerCode 下都能执行。哪个模块不可用，网关会直接拒绝，
 * 工具会把原因如实回报，不会假装成功。
 */
const INVENTORY_CONSUMERS = [
  "branch-inventory",
  "base-safety-stock",
  "full-chain-inventory",
  "dealer-inventory-replenishment",
  "inventory-personal-workbench",
  "customer-inventory-preview",
  "orderworkbench-preview",
  "orderfulfillment-preview",
];

export const CAPABILITY_RECIPES: Readonly<Record<string, readonly CapabilityRecipe[]>> =
  Object.fromEntries(
    INVENTORY_CONSUMERS.map((consumerCode) => [
      consumerCode,
      [shortageByBaseAndGroup, shortageByMaterial],
    ]),
  );

export function recipesFor(consumerCode: string): readonly CapabilityRecipe[] {
  return CAPABILITY_RECIPES[consumerCode] ?? [];
}

export function findRecipe(
  consumerCode: string,
  id: string,
): CapabilityRecipe | undefined {
  return recipesFor(consumerCode).find((recipe) => recipe.id === id);
}

/** 参数是否齐全；缺哪个直接说哪个，避免拼出半截 SQL 让网关报"执行失败"。 */
export function missingRecipeParams(
  recipe: CapabilityRecipe,
  parameters: Record<string, unknown>,
): string[] {
  return (recipe.params ?? [])
    .filter((param) => param.required === true)
    .filter((param) => {
      const value = parameters[param.name];
      return value === undefined || value === null || value === "";
    })
    .map((param) => param.name);
}
