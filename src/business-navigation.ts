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
