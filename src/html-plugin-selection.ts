const legacyApsIds = new Set([
  "inventory-apsboard",
  "inventory-apsdemand",
  "inventory-apsdelivery",
]);

export function selectHtmlPlugins<T extends { id: string; replaces?: string[] }>(
  plugins: T[],
): T[] {
  const unified = plugins.find((plugin) => plugin.id === "inventory-apsplan");
  const replaced = new Set(
    Array.isArray(unified?.replaces) ? unified.replaces.filter((id) => legacyApsIds.has(id)) : [],
  );
  return plugins.filter((plugin) => !replaced.has(plugin.id));
}

export function isHtmlPluginRetired(id: string, mock: boolean, hidden: readonly string[]): boolean {
  const retainedPreview = [
    "inventory-apsplan",
    "inventory-dms",
    "inventory-customer",
    "inventory-orderworkbench",
    "inventory-orderfulfillment",
    "plan-regional",
    "category-plan",
    "inventory-mps",
    "inventory-qll",
    "inventory-dealer",
    "inventory-personal",
  ].includes(id);
  return (mock && !retainedPreview) || hidden.includes(id);
}
