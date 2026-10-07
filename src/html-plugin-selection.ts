const legacyApsIds = new Set([
  "inventory-apsboard", "inventory-apsdemand", "inventory-apsdelivery",
]);

/** Only the consolidated APS manifest may retire the three legacy APS plugins. */
export function selectHtmlPlugins<T extends { id: string; replaces?: string[] }>(plugins: T[]): T[] {
  const unified = plugins.find(plugin => plugin.id === "inventory-apsplan");
  const replaced = new Set(
    Array.isArray(unified?.replaces)
      ? unified.replaces.filter(id => legacyApsIds.has(id))
      : [],
  );
  return plugins.filter(plugin => !replaced.has(plugin.id));
}

/** Requested development pages retain their panels and conversation bindings. */
export function isHtmlPluginRetired(id: string, mock: boolean, hidden: readonly string[]): boolean {
  const retainedPreview = ["inventory-customer", "inventory-orderworkbench", "inventory-orderfulfillment", "plan-regional", "category-plan", "inventory-mps", "inventory-qll", "inventory-dealer", "inventory-personal"].includes(id);
  return (mock && !retainedPreview) || hidden.includes(id);
}
