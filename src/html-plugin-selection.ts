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
