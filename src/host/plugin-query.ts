/**
 * 受管只读查询的请求整形。
 *
 * 线上实测：同一条业务 SQL，走分页路径成功、不走分页路径报底层错误。宿主统一
 * 替调用方（模型工具、业务页面）补上分页，模型不必自己记得传页码；页面自己要
 * 分组打包读取（`packing`）时保持原样，不走分页。
 */
export const PLUGIN_QUERY_DEFAULT_PAGE_SIZE = 200;

/**
 * 网关对单页行数的硬上限（`readHtmlQuery` 超过就判非法）。
 * 工具说明里给模型看的上限不能比它大，否则模型照着说明要 1000 行只会拿到
 * `INVALID_PAGE`——真实的线上现象。宿主在这里统一钳制，模型不必知道这个数。
 */
export const PLUGIN_QUERY_MAX_PAGE_SIZE = 200;

const clampInteger = (value: unknown, min: number, max: number, fallback: number) => {
  const number = typeof value === "number" ? value : Number(value);
  // 非法或小于下限（例如 0）按"没给"处理：退回默认值比返回一页 1 行更可预期。
  if (!Number.isSafeInteger(number) || number < min) return fallback;
  return Math.min(max, number);
};

export function withDefaultPaging<T extends Record<string, unknown>>(query: T): T {
  // 分组打包读取是另一条路径（网关不接受页码），保持原样。
  if (query.packing !== undefined) return query;
  return {
    ...query,
    pageNo: clampInteger(query.pageNo, 1, Number.MAX_SAFE_INTEGER, 1),
    pageSize: clampInteger(
      query.pageSize,
      1,
      PLUGIN_QUERY_MAX_PAGE_SIZE,
      PLUGIN_QUERY_DEFAULT_PAGE_SIZE,
    ),
  };
}

/**
 * 只读查询失败时，把"下一步怎么办"补进错误信息。
 *
 * 线上现象：模型猜了一张该模块没发布的表，拿到的是
 * `GEA SQL 查询失败（业务码 500）：数据表未发布为可访问资源`——话说清了，但没告诉它
 * 该换成清单里的表或先 describe，于是继续换着表猜。
 *
 * `errorEnvelope.readableMessage` 只放行 200 字以内的短句，所以这里同时把原文截断，
 * 保证"原文 + 提示"落在预算内，不会被整条丢掉。
 */
export function pluginReadHint(
  message: string,
  tables: readonly string[] = [],
): string {
  const listed = tables.slice(0, 3).join("、");
  const hint = listed
    ? `；该表可能不在本模块可读清单：先用 describe=true 取列名，或改用清单中的表（如 ${listed}）`
    : "；先用 describe=true 取该模块可读的表与列名，再按清单重试";
  const budget = 200 - hint.length;
  const head =
    message.length > budget
      ? message.slice(0, Math.max(1, budget - 1)) + "…"
      : message;
  return head + hint;
}
