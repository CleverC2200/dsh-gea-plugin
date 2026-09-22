/**
 * 当前页身份：对话这一刻"人正看着哪个业务页"的宿主事实。
 *
 * 线上现象：用户在「经销商库存」页提问，会话里却只有"客户库存"的绑定；模型手上同时
 * 有一屏页面工具（每个模块一个 `<id>_page`），没有任何"当前页是谁"的权威信号，于是
 * 读了另一个模块的页面，拿到空上下文，最后只能拒答。
 *
 * 页面自己每秒都在向宿主报"我还在"（页面桥轮询），这里按最近一次页面活动记录身份，
 * 超过 TTL 没活动就视为没有页面。对话侧（页面工具、当前页快照）只认这一份事实。
 */

export type PageIdentity = {
  /** 模块 id，例如 `inventory-dealer`。 */
  pluginId: string;
  /** 模块声明的 consumerCode；演示页也有，只作标识用。 */
  consumerCode: string;
  /** 给模型看的模块名，例如 `经销商库存`。 */
  label: string;
  /** 这个页面的对话入口工具名，例如 `inventory_dealer_page`。 */
  pageTool: string;
  /** 演示（mock）模块要如实标出来，避免把它的数字当业务事实。 */
  mock?: boolean;
  /** 最近一次页面活动时间（毫秒）。 */
  at: number;
};

/** 页面身份多久没活动就算过期：页面桥每秒轮询，90 秒足够区分"切走了"和"网络抖动"。 */
export const PAGE_IDENTITY_TTL_MS = 90_000;

export function pageToolName(pluginId: string): string {
  return pluginId.replace(/-/g, "_") + "_page";
}

/** 这份身份还算不算"当前页"。 */
export function pageIdentityFresh(
  identity: PageIdentity,
  now = Date.now(),
): boolean {
  return now - identity.at <= PAGE_IDENTITY_TTL_MS;
}

const currentPage = (identity: PageIdentity) => ({
  pluginId: identity.pluginId,
  label: identity.label,
  consumerCode: identity.consumerCode,
  tool: identity.pageTool,
  mock: identity.mock === true,
});

/** 页面开着、但这一类页面不向宿主上报可见行快照（HTML 插件页）时的权威回答。 */
export function currentPageEnvelope(identity: PageIdentity): string {
  return JSON.stringify({
    source: "GEA_RENDERED_WORKBENCH",
    coverage: "none",
    authority: "read-only-ui-context",
    availability: "html-plugin-page",
    code: "PAGE_HAS_NO_SNAPSHOT",
    currentPage: currentPage(identity),
    reason:
      `当前页是「${identity.label}」：这一类页面不上报可见数据快照，所以拿不到"这一屏"的行数据。` +
      `要读这一屏请用页面工具 ${identity.pageTool}（先 context）；口径或范围问题请用受管只读直读该模块（consumerCode ${identity.consumerCode}），不要读别的页面。` +
      (identity.mock
        ? "另：这个模块是演示数据，它的数字不能当业务事实引用。"
        : ""),
  });
}

/** 调用了"不是当前页"的页面工具时的权威回答：说清当前页，并给出该用的工具。 */
export function wrongPageEnvelope(
  identity: PageIdentity,
  requestedLabel: string,
): string {
  return JSON.stringify({
    source: "GEA_PAGE",
    availability: "wrong-page",
    code: "PAGE_IDENTITY_MISMATCH",
    page: requestedLabel,
    currentPage: currentPage(identity),
    reason:
      `当前页是「${identity.label}」，不是「${requestedLabel}」：「${requestedLabel}」此刻没有打开，读不到它的这一屏。` +
      `请改用 ${identity.pageTool}；数据口径问题用受管只读直读模块（consumerCode ${identity.consumerCode}）。不要读别的页面，也不要让用户先去开页面。`,
  });
}
