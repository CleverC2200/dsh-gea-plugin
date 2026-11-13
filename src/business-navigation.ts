type Entry = { options: { key?: string; label?: (() => string) | string; order?: number } };

const BUSINESS_MENU_LABELS: Readonly<Record<string, string>> = {
  "inventory-aqkc": "基地库存",
  "inventory-qll": "全链库存",
};

export const businessMenuLabel = (pageId: string, fallback: string): string =>
  BUSINESS_MENU_LABELS[pageId] ?? fallback;

export function registeredBusinessPanels(entries: readonly Entry[]) {
  return entries
    .filter((entry) => entry.options.key?.startsWith("inventory-") && entry.options.label)
    .map(({ options }) => ({
      id: options.key!,
      title: (typeof options.label === "function" ? options.label() : options.label!).replace(
        /\s+Agent$/i,
        "",
      ),
      order: options.order ?? 0,
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
export function isGeaBusinessPanel(
  panel: string | null | undefined,
  entries: readonly Entry[],
): boolean {
  return (
    GEA_SHELL_PANELS.includes(panel ?? "") ||
    registeredBusinessPanels(entries).some((item) => item.id === panel)
  );
}

export const GEA_SHELL_PANELS: readonly string[] = [
  "gea-proof",
  "gea-regional-plan",
  "plan-region-category",
  "plan-category-production",
  "gea-inbox",
];

export type BusinessPanel = { id: string; title: string; order: number };

export const MAIN_MENU = "main";

export function businessMenuTitle(
  id: string,
  panels: readonly BusinessPanel[] = [],
  override: Readonly<Record<string, string>> = {},
): string {
  if (id === MAIN_MENU) return "主对话";
  const registered = panels.find((panel) => panel.id === id)?.title;
  if (registered) return registered;
  if (override[id]) return override[id]!;
  for (const group of BUSINESS_MENU_PRESET)
    for (const item of group.items)
      if (item.id === id) return item.title.replace(/\((开发中|待设计)\)$/, "");
  return id;
}

export type BusinessMenuSection = "supply" | "plan" | "inventory" | "orders" | "prototypes";
export type BusinessMenuItem = { id: string; title: string };
export type BusinessMenuGroup = {
  key: BusinessMenuSection;
  title: string;
  icon: string;
  flat?: boolean;
  items: readonly BusinessMenuItem[];
};
export type BusinessMenuEntry = { id: string; title: string; disabled: boolean };
export type ResolvedBusinessMenuGroup = {
  key: BusinessMenuSection;
  title: string;
  icon: string;
  flat: boolean;
  entries: BusinessMenuEntry[];
};

export const BUSINESS_MENU_PRESET: readonly BusinessMenuGroup[] = [
  {
    key: "supply",
    title: "产销协同",
    icon: "synergy",
    items: [{ id: "inventory-apsplan", title: "产销协同工作台" }],
  },
  {
    key: "plan",
    title: "计划管理",
    icon: "calendar",
    items: [
      { id: "plan-region-category", title: "品类计划工作台(开发中)" },
      { id: "gea-proof", title: "销售计划" },
      { id: "gea-regional-plan", title: "区域计划(开发中)" },
      { id: "plan-category-production", title: "主生产计划(MPS)(开发中)" },
      { id: "plan-capacity-assessment", title: "产能评估(待设计)" },
    ],
  },
  {
    key: "inventory",
    title: "库存管理",
    icon: "warehouse",
    items: [
      { id: "inventory-qll", title: "全链库存工作台" },
      { id: "inventory-aqkc", title: "基地库存" },
      { id: "inventory-fc", title: "分仓库存" },
      { id: "inventory-customer", title: "客户库存(开发中)" },
    ],
  },

  {
    key: "orders",
    title: "订单管理",
    icon: "orders",
    items: [
      { id: "inventory-orderworkbench", title: "订单工作台(开发中)" },
      { id: "inventory-orderfulfillment", title: "订单履约(开发中)" },
    ],
  },
  {
    key: "prototypes",
    title: "原型演示",
    icon: "orders",
    items: [{ id: "inventory-dms", title: "DMS 回写演示（模拟）" }],
  },
];

export function resolveBusinessMenu(
  preset: readonly BusinessMenuGroup[],
  available: ReadonlyMap<string, string>,
): ResolvedBusinessMenuGroup[] {
  return preset
    .map((group) => ({
      key: group.key,
      title: group.title,
      icon: group.icon,
      flat: group.flat === true,
      entries: group.items.map((item) => ({
        id: item.id,
        title: item.title,
        disabled: !available.has(item.id),
      })),
    }))
    .filter((group) => group.entries.length > 0);
}

export const NATIVE_REFERENCE_MENUS: Readonly<Record<string, string>> = {
  "gea-workbench": "gea-proof",
  "gea-regional-plan": "gea-regional-plan",
  "plan-region-category": "plan-region-category",
  "plan-category-production": "plan-category-production",
};
