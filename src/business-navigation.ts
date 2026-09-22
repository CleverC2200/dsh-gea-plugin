/** Plugins declare their navigation using the standard DSH main-slot label/order. */
type Entry = { options: { key?: string; label?: (() => string) | string; order?: number } };

/**
 * 业务菜单显示名覆盖表：HTML 插件的 `plugin.json` 由别的仓库发布，改菜单文案不必重发插件包。
 * 只影响侧边栏菜单名，插件内部页面自己的标题仍由插件包决定。
 */
const BUSINESS_MENU_LABELS: Readonly<Record<string, string>> = {
  'inventory-aqkc': '基地库存',
  'inventory-qll': '全链库存',
};

export const businessMenuLabel = (pageId: string, fallback: string): string =>
  BUSINESS_MENU_LABELS[pageId] ?? fallback;

export function registeredBusinessPanels(entries: readonly Entry[]) {
 return entries.filter(entry => entry.options.key?.startsWith('inventory-') && entry.options.label)
 .map(({options}) => ({id: options.key!, title: (typeof options.label === 'function' ? options.label() : options.label!).replace(/\s+Agent$/i, ""), order: options.order ?? 0}))
  .sort((a,b) => a.order-b.order || a.id.localeCompare(b.id));
}
export function isGeaBusinessPanel(panel: string | null | undefined, entries: readonly Entry[]): boolean {
 return panel==='gea-proof' || panel==='gea-regional-plan' || panel==='gea-inbox' || registeredBusinessPanels(entries).some(item=>item.id===panel);
}

export type BusinessPanel = { id: string; title: string; order: number };

/**
 * 菜单状态字段里的"主对话"。宿主（host/workbench-surface.ts）与会话侧共用这一个值：
 * 默认就是它，用户点业务菜单时才换成对应菜单 id。
 */
export const MAIN_MENU = "main";

/** 菜单 id → 菜单名：优先用已注册页面自己的标题，其次用原型目录里的名字。 */
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
      if (item.id === id)
        return item.title.replace(/\((开发中|待设计)\)$/, "");
  return id;
}

/**
 * 左侧业务菜单的分组与顺序以原型（GEA_AI工作台_右侧目录.html）为准：
 * 产销协同 → 计划管理 → 库存管理 → 订单管理。
 * 原型中尚未接入的页面也保留为禁用占位，避免不同账号看到的目录结构跳动。
 */
export type BusinessMenuSection = "supply" | "plan" | "inventory" | "orders";
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
      { id: "plan-region-category", title: "区域及品类计划工作台(开发中)" },
      { id: "gea-proof", title: "销售计划" },
      { id: "gea-regional-plan", title: "区域计划(开发中)" },
      { id: "plan-category-production", title: "品类与生产计划(开发中)" },
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
      { id: "inventory-orderworkbench", title: "订单管理工作台(开发中)" },
      { id: "inventory-orderfulfillment", title: "订单履约(开发中)" },
    ],
  },
];

/** 固定展示原型目录；没有接入页面的条目显示为禁用占位。 */
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
      entries: group.items
        .map((item) => ({
          id: item.id,
          title: item.title,
          disabled: !available.has(item.id),
        })),
    }))
    .filter((group) => group.entries.length > 0);
}
