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
 * 左侧业务菜单的分组与顺序以原型（GEA_AI工作台_右侧目录.html）为准：
 * 产销协同 → 计划管理 → 库存管理 → 订单履约。
 * 每个条目只登记「页面 id」；页面没接入就没有关联数据，渲染时自动隐藏。
 */
export type BusinessMenuSection = "supply" | "plan" | "inventory" | "orders";
export type BusinessMenuItem = { id: string; title?: string };
export type BusinessMenuGroup = {
  key: BusinessMenuSection;
  title: string;
  icon: string;
  items: readonly BusinessMenuItem[];
};
export type BusinessMenuEntry = { id: string; title: string };
export type ResolvedBusinessMenuGroup = {
  key: BusinessMenuSection;
  title: string;
  icon: string;
  entries: BusinessMenuEntry[];
};

export const BUSINESS_MENU_PRESET: readonly BusinessMenuGroup[] = [
  { key: "supply", title: "产销协同", icon: "synergy", items: [{ id: "inventory-apsplan" }] },
  {
    key: "plan",
    title: "计划管理",
    icon: "calendar",
    items: [
      { id: "gea-regional-plan" },
      { id: "gea-proof" },
      // 生产计划等页面接入后会自动出现在这里。
      { id: "inventory-production", title: "生产计划" },
    ],
  },
  {
    key: "inventory",
    title: "库存管理",
    icon: "warehouse",
    items: [
      { id: "inventory-qll" },
      { id: "inventory-aqkc" },
      { id: "inventory-fc" },
      { id: "inventory-dealer" },
      { id: "inventory-customer", title: "客户库存" },
    ],
  },
  {
    key: "orders",
    title: "订单履约",
    icon: "orders",
    items: [
      { id: "inventory-orderworkbench", title: "订单工作台" },
      { id: "inventory-orderfulfillment", title: "订单履约" },
    ],
  },
];

/** 只保留已接入页面的条目；整组都没有页面时连分组一起隐藏。 */
export function resolveBusinessMenu(
  preset: readonly BusinessMenuGroup[],
  available: ReadonlyMap<string, string>,
): ResolvedBusinessMenuGroup[] {
  return preset
    .map((group) => ({
      key: group.key,
      title: group.title,
      icon: group.icon,
      entries: group.items
        .filter((item) => available.has(item.id))
        .map((item) => ({ id: item.id, title: available.get(item.id) || item.title || item.id })),
    }))
    .filter((group) => group.entries.length > 0);
}
