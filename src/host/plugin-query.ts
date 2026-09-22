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
 * 另一种线上现象：模型写 `where cust_code = ?` 配 `parameters {"1": …}`，守卫报
 * `UNUSED_QUERY_PARAMETER`，却仍然被贴上"该表可能不在本模块可读清单"。模型于是去换
 * 表、换模块，白烧十几步。这里先看失败原因：参数类错误只提示占位符写法，只有真的
 * 表或列没发布时才提 describe 与清单。
 *
 * `errorEnvelope.readableMessage` 只放行 200 字以内的短句，所以这里同时把原文截断，
 * 保证"原文 + 提示"落在预算内，不会被整条丢掉。提示里不能出现斜杠，否则整条会被
 * 当成"内部细节"过滤掉。
 */
const PARAMETER_ERROR_CODES = [
  "INVALID_QUERY_PARAMETERS",
  "MISSING_QUERY_PARAMETER",
  "UNUSED_QUERY_PARAMETER",
  "RESERVED_QUERY_PARAMETER",
  "POSITIONAL_QUERY_PARAMETER",
  "MIXED_QUERY_PARAMETERS",
];

/** 只有这些才说明"表或列不在清单里"，别的失败不要往这上面引。 */
const TABLE_ERROR_MARKERS = [
  "RESOURCE_NOT_PUBLISHED",
  "FIELD_NOT_PUBLISHED",
  "NO_RETURN_COLUMN_ALLOWED",
  "数据表未发布",
  "字段未发布",
  "表不存在",
  "does not exist",
  "no such column",
  "no such table",
];

export function pluginReadHint(
  message: string,
  tables: readonly string[] = [],
): string {
  const listed = tables.slice(0, 3).join("、");
  const hint = PARAMETER_ERROR_CODES.some((code) => message.includes(code))
    ? '；SQL 参数写法：占位符用 :name（例如 where cust_code = :cust），parameters 传 {"cust":"…"}，不要用 ?'
    : TABLE_ERROR_MARKERS.some((marker) => message.includes(marker))
      ? listed
        ? `；该表或列不在本模块可读清单：先用 describe=true 取列名，或改用清单中的表（如 ${listed}）`
        : "；先用 describe=true 取该模块可读的表与列名，再按清单重试"
      : "；先 describe=true 核对表与列名；宽表聚合要先收窄口径（加月份、基地、物料过滤），不要整表聚合";
  const budget = 200 - hint.length;
  const head =
    message.length > budget
      ? message.slice(0, Math.max(1, budget - 1)) + "…"
      : message;
  return head + hint;
}

/**
 * 列清单探查的预算与并发。
 *
 * 线上现象：`describe=true` 把模块声明的表**串行**探一遍（一张表一次网关调用，1~5 秒），
 * 十几张表直接把工具的 15 秒超时跑爆，模型只拿到 `tool call timed out`。
 * 这里把探查变成"有预算的并行"：先探最前面的若干张，做完就返回，
 * 剩下的如实标成 skipped 让调用方下一轮再要，绝不因为超时把整次调用废掉。
 */
export const PLUGIN_SCHEMA_MAX_TABLES = 6;
export const PLUGIN_SCHEMA_PROBE_CONCURRENCY = 3;
export const PLUGIN_SCHEMA_PROBE_BUDGET_MS = 9000;
export const PLUGIN_SCHEMA_PROBE_TIMEOUT_MS = 6000;

export type TableProbeOutcome<T> = {
  table: string;
  value?: T;
  error?: string;
};

export async function probeTables<T>(
  tables: readonly string[],
  run: (table: string, signal: AbortSignal) => Promise<T>,
  options: {
    limit?: number;
    concurrency?: number;
    budgetMs?: number;
    perProbeMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ outcomes: Array<TableProbeOutcome<T>>; skipped: string[] }> {
  const limit = Math.max(
    0,
    Math.min(options.limit ?? PLUGIN_SCHEMA_MAX_TABLES, tables.length),
  );
  const concurrency = Math.max(1, options.concurrency ?? PLUGIN_SCHEMA_PROBE_CONCURRENCY);
  const budgetMs = options.budgetMs ?? PLUGIN_SCHEMA_PROBE_BUDGET_MS;
  const perProbeMs = options.perProbeMs ?? PLUGIN_SCHEMA_PROBE_TIMEOUT_MS;
  const picked = tables.slice(0, limit);
  const skipped = [...tables.slice(limit)];
  const outcomes: Array<TableProbeOutcome<T>> = [];
  const started = Date.now();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= picked.length) return;
      const table = picked[index];
      const remaining = budgetMs - (Date.now() - started);
      if (remaining <= 0) {
        skipped.push(table);
        continue;
      }
      // 单张表也要有上限：某张表慢，不能拖着整次调用一起完蛋。
      const timeout = AbortSignal.timeout(Math.min(perProbeMs, remaining));
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      try {
        outcomes.push({ table, value: await run(table, signal) });
      } catch (error) {
        outcomes.push({
          table,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, picked.length) }, () => worker()),
  );
  outcomes.sort((a, b) => picked.indexOf(a.table) - picked.indexOf(b.table));
  return { outcomes, skipped };
}
