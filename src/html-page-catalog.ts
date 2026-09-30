/** Pages publish elements; GEA owns the surface/tool identity and validates their data. */
export function htmlPageCatalog(input: {pluginId: string; label: string; elements: unknown}) {
  if (!Array.isArray(input.elements) || !input.elements.length) return null;
  return {
    surface: `gea-html-${input.pluginId}`, tool: "gea_plugin_page_apply", reasonField: "reason",
    description: `操作「${input.label}」主动声明的当前可见元素。只读元素不可写；只执行目录列出的动作。`,
    elements: input.elements,
  };
}
