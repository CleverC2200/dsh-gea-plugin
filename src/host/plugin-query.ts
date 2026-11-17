export const PLUGIN_QUERY_DEFAULT_PAGE_SIZE = 200;

export const PLUGIN_QUERY_MAX_PAGE_SIZE = 200;

const clampInteger = (value: unknown, min: number, max: number, fallback: number) => {
  const number = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(number) || number < min) return fallback;
  return Math.min(max, number);
};

export function withDefaultPaging<T extends Record<string, unknown>>(query: T): T {
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

const PARAMETER_ERROR_CODES = [
  "INVALID_QUERY_PARAMETERS",
  "MISSING_QUERY_PARAMETER",
  "UNUSED_QUERY_PARAMETER",
  "RESERVED_QUERY_PARAMETER",
  "POSITIONAL_QUERY_PARAMETER",
  "MIXED_QUERY_PARAMETERS",
];

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

export function pluginReadHint(message: string, tables: readonly string[] = []): string {
  const listed = tables.slice(0, 3).join("、");
  const hint = PARAMETER_ERROR_CODES.some((code) => message.includes(code))
    ? '；SQL 参数写法：占位符用 :name（例如 where cust_code = :cust），parameters 传 {"cust":"…"}，不要用 ?'
    : TABLE_ERROR_MARKERS.some((marker) => message.includes(marker))
      ? listed
        ? `；该表或列不在本模块可读清单：先用 describe=true 取列名，或改用清单中的表（如 ${listed}）`
        : "；先用 describe=true 取该模块可读的表与列名，再按清单重试"
      : "；先 describe=true 核对表与列名；宽表聚合要先收窄口径（加月份、基地、物料过滤），不要整表聚合";
  const budget = 200 - hint.length;
  const head = message.length > budget ? message.slice(0, Math.max(1, budget - 1)) + "…" : message;
  return head + hint;
}

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
  const limit = Math.max(0, Math.min(options.limit ?? PLUGIN_SCHEMA_MAX_TABLES, tables.length));
  const concurrency = Math.max(1, options.concurrency ?? PLUGIN_SCHEMA_PROBE_CONCURRENCY);
  const budgetMs = options.budgetMs ?? PLUGIN_SCHEMA_PROBE_BUDGET_MS;
  const perProbeMs = options.perProbeMs ?? PLUGIN_SCHEMA_PROBE_TIMEOUT_MS;
  const picked = tables.slice(0, limit);
  const skipped = tables.slice(limit);
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

      const timeout = AbortSignal.timeout(Math.min(perProbeMs, remaining));
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
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
  await Promise.all(Array.from({ length: Math.min(concurrency, picked.length) }, () => worker()));
  outcomes.sort((a, b) => picked.indexOf(a.table) - picked.indexOf(b.table));
  return { outcomes, skipped };
}
