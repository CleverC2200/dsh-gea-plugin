/** Plugins declare their navigation using the standard DSH main-slot label/order. */
type Entry = { options: { key?: string; label?: (() => string) | string; order?: number } };
export function registeredBusinessPanels(entries: readonly Entry[]) {
 return entries.filter(entry => entry.options.key?.startsWith('inventory-') && entry.options.label)
 .map(({options}) => ({id: options.key!, title: (typeof options.label === 'function' ? options.label() : options.label!).replace(/\s+Agent$/i, ""), order: options.order ?? 0}))
  .sort((a,b) => a.order-b.order || a.id.localeCompare(b.id));
}
export function isGeaBusinessPanel(panel: string | null | undefined, entries: readonly Entry[]): boolean {
 return panel==='gea-proof' || panel==='gea-regional-plan' || panel==='gea-inbox' || registeredBusinessPanels(entries).some(item=>item.id===panel);
}

/** 业务菜单按四个顶层分组展示：产销协同工作台、客户管理、计划管理、库存管理。 */
export type BusinessPanel = { id: string; title: string; order: number };
export type BusinessPanelGroups = { board?: BusinessPanel; customer: BusinessPanel[]; plan: BusinessPanel[]; inventory: BusinessPanel[] };
export function groupBusinessPanels(panels: readonly BusinessPanel[]): BusinessPanelGroups {
  return {
    board: panels.find(({ id }) => id === "inventory-apsboard"),
    customer: panels.filter(({ id }) => id === "inventory-dealer"),
    plan: panels.filter(({ id }) => id.startsWith("inventory-aps") && id !== "inventory-apsboard"),
    inventory: panels.filter(({ id }) => id !== "inventory-dealer" && !id.startsWith("inventory-aps")),
  };
}
