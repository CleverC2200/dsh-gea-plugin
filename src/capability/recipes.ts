export type CapabilityRecipeParam = {
  name: string;
  description: string;

  required?: boolean;
};

export type CapabilityRecipe = {
  id: string;

  title: string;
  sql: string;
  params?: CapabilityRecipeParam[];
};

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

const INVENTORY_CONSUMERS = [
  "branch-inventory",
  "base-safety-stock",
  "full-chain-inventory",
  "dealer-inventory-replenishment",
  "inventory-personal-workbench",
  "customer_inventory",
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

export function findRecipe(consumerCode: string, id: string): CapabilityRecipe | undefined {
  return recipesFor(consumerCode).find((recipe) => recipe.id === id);
}

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
