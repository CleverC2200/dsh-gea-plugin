export type PageIdentity = {
  pluginId: string;

  consumerCode: string;

  label: string;

  pageTool: string;

  mock?: boolean;

  at: number;
};

export const PAGE_IDENTITY_TTL_MS = 90_000;

export const PAGE_TOOL = "gea_page";

export function pageIdentityFresh(identity: PageIdentity, now = Date.now()): boolean {
  return now - identity.at <= PAGE_IDENTITY_TTL_MS;
}

const currentPage = (identity: PageIdentity) => ({
  pluginId: identity.pluginId,
  label: identity.label,
  consumerCode: identity.consumerCode,
  tool: identity.pageTool,
  mock: identity.mock === true,
});

export function currentPageEnvelope(identity: PageIdentity): string {
  if (identity.pageTool !== PAGE_TOOL)
    return JSON.stringify({
      source: "GEA_RENDERED_WORKBENCH",
      coverage: "none",
      authority: "read-only-ui-context",
      availability: "in-workbench-no-snapshot",
      code: "PAGE_HAS_NO_SNAPSHOT",
      currentPage: currentPage(identity),
      reason: `当前页是「${identity.label}」，但这一屏还没有上报可见行快照，不能推断页面数据。页面动作由 ${identity.pageTool} 按实际元素目录提供；等待页面上报后，用 gea_visible_workbench_context 读取可见内容。`,
    });
  return JSON.stringify({
    source: "GEA_RENDERED_WORKBENCH",
    coverage: "none",
    authority: "read-only-ui-context",
    availability: "html-plugin-page",
    code: "PAGE_HAS_NO_SNAPSHOT",
    currentPage: currentPage(identity),
    reason:
      `当前页是「${identity.label}」：这一类页面不上报可见数据快照，所以拿不到"这一屏"的行数据。` +
      `要读这一屏请用 ${PAGE_TOOL}（action=context，可按 focus 收窄）；口径或范围问题请用受管只读直读该模块（consumerCode ${identity.consumerCode}）。` +
      (identity.mock ? "另：这个模块是演示数据，它的数字不能当业务事实引用。" : ""),
  });
}
