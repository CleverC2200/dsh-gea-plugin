/**
 * 受管只读查询的请求整形。
 *
 * 线上实测：同一条业务 SQL，走分页路径成功、不走分页路径报底层错误。宿主统一
 * 替调用方（模型工具、业务页面）补上分页，模型不必自己记得传页码；页面自己要
 * 分组打包读取（`packing`）时保持原样，不走分页。
 */
export const PLUGIN_QUERY_DEFAULT_PAGE_SIZE = 200;

export function withDefaultPaging<T extends Record<string, unknown>>(query: T): T {
  if (query.pageNo !== undefined || query.packing !== undefined) return query;
  return {
    ...query,
    pageNo: 1,
    pageSize: query.pageSize ?? PLUGIN_QUERY_DEFAULT_PAGE_SIZE,
  };
}
