/**
 * 只读配方集中保存常见问题的口径、连接和过滤规则，按 id 执行参数化 SQL。
 * 配方不写 LIMIT/OFFSET，分页由宿主统一处理；未覆盖问题仍受原 describe 与查询合同约束。
 * 配方存在不证明当前环境授权、数据或真机验收通过。
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
