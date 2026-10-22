import { GeaResponseError } from "./shared/gea-error.js";
// Shared GEA transport, adapted from the verified inventory pagination implementation.
import { randomUUID } from "node:crypto";

type Scalar = string | number | boolean | null;
type Row = Record<string, unknown>;
type ColumnMetadata = { returnedColumns?: unknown[]; rejectedColumns?: unknown[] };
type SqlRows = ColumnMetadata & { rows: Row[]; total?: number | null };
export type ConfiguredSqlRequest = {
  sql: string;
  parameters: Record<string, unknown>;
  includeTotal: false;
};
type QueryOptions = { pageSize: number; pageNo?: number; configured?: ConfiguredSqlRequest };
/** One Host-owned allowance is reused by all queries and renewed delegations. */
export type SqlReadLimit = { maxRows: number; maxPages: number; beforeRequest(): void };
export type RowPacking = {
  keys: string[];
  order: string[];
  timestamps?: string[];
};
export type BusinessDatabase = {
  queryConfigured?(request: ConfiguredSqlRequest): Promise<SqlRows>;
  query(sql: string, values?: unknown[]): Promise<SqlRows>;
  queryPage(sql: string, values: unknown[], pageNo: number, pageSize: number): Promise<SqlRows>;
  queryPackedRows?(sql: string, values: unknown[], packing: RowPacking): Promise<{ rows: Row[] }>;
  queryWithOptions?(
    sql: string,
    values: unknown[],
    options: QueryOptions,
  ): Promise<{ rows: Row[] }>;
};

export function queryBusinessDatabase(
  database: BusinessDatabase,
  sql: string,
  values: unknown[],
  options: QueryOptions,
) {
  return database.queryWithOptions
    ? database.queryWithOptions(sql, values, options)
    : database.query(sql, values);
}

/** Domain rows are still fully returned; grouping only reduces gateway pagination round trips. */
export function queryPackedBusinessRows(
  database: BusinessDatabase,
  sql: string,
  values: unknown[],
  packing: RowPacking,
) {
  return database.queryPackedRows
    ? database.queryPackedRows(sql, values, packing)
    : database.query(sql, values);
}
export function packedRowsSql(sql: string, packing: RowPacking) {
  if (
    !packing.keys.length ||
    !packing.order.length ||
    [...packing.keys, ...packing.order, ...(packing.timestamps ?? [])].some(
      (key) => !/^[a-z][a-z0-9_]*$/.test(key),
    )
  )
    throw new GeaSqlError("GEA_SQL_PARAMETER_INVALID", "业务分组配置无效", 400);
  // Match the gateway's scalar timestamp serialization, including nulls.
  const rowJson =
    "TO_JSONB(dsh_source_rows)" +
    (packing.timestamps ?? [])
      .map(
        (key) =>
          ` || JSONB_BUILD_OBJECT('${key}', TO_CHAR(dsh_source_rows.${key}, 'YYYY-MM-DD HH24:MI:SS'))`,
      )
      .join("");
  return `WITH dsh_source_rows AS (${sql})
 SELECT ${packing.keys.join(", ")}, COUNT(*) AS dsh_row_count,
 JSONB_AGG((${rowJson}) ORDER BY ${packing.order.join(", ")})::text AS dsh_rows
 FROM dsh_source_rows GROUP BY ${packing.keys.join(", ")} ORDER BY ${packing.keys.join(", ")}`;
}
export function unpackBusinessRows(groups: Row[]) {
  const rows: Row[] = [];
  for (const group of groups) {
    let packed = group.dsh_rows;
    if (typeof packed === "string") {
      if (packed.length > 20_000_000)
        throw new GeaSqlError("GEA_SQL_RESULT_TOO_LARGE", "业务明细超过读取上限", 502);
      try {
        packed = JSON.parse(packed);
      } catch {
        throw new GeaSqlError("GEA_SQL_RESPONSE_INVALID", "业务明细分组格式无效", 502);
      }
    }
    if (
      !Array.isArray(packed) ||
      !packed.every(record) ||
      packed.length !== Number(group.dsh_row_count)
    )
      throw new GeaSqlError("GEA_SQL_RESULT_INCOMPLETE", "业务明细分组不完整", 502, true);
    if (rows.length + packed.length > 100000)
      throw new GeaSqlError("GEA_SQL_RESULT_TOO_LARGE", "业务明细超过读取上限", 502);
    rows.push(...packed);
  }
  return { rows };
}

export class GeaSqlError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  failure?: Record<string, unknown>;
  gatewayErrorCode?: string;
  returnedColumns?: unknown[];
  rejectedColumns?: unknown[];
  constructor(code: string, message: string, status = 503, retryable = false) {
    super(message);
    this.name = "GeaSqlError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function usesGeaSql() {
  const mode = process.env.WORKBENCH_SQL_MODE?.trim().toLowerCase();
  if (mode && mode !== "gea" && mode !== "direct")
    throw new GeaSqlError("GEA_SQL_MODE_INVALID", "业务查询模式配置无效");
  return mode
    ? mode === "gea"
    : process.env.NEXT_PUBLIC_APP_MODE === "gea" ||
        process.env.GEA_REQUIRE_LAUNCH_SESSION === "true";
}

// 固定业务 SQL 的位置参数转为销售预测同款命名参数；值不拼入 SQL。
// 文本数组展开为标量参数组成的 ARRAY，兼容 GEA 的标量 parameters 契约。
export function prepareGeaSql(sql: string, values: unknown[] = []) {
  const parameters: Record<string, Scalar> = {};
  const scalar = (name: string, value: unknown) => {
    if (
      !(
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      )
    ) {
      throw new GeaSqlError("GEA_SQL_PARAMETER_INVALID", "业务查询参数无效", 400);
    }
    parameters[name] = value;
    return `:${name}`;
  };
  // GEA resolves business tables itself; a PG schema qualifier is interpreted as
  // a database name there. Strip it only in this adapter, not in direct PG SQL.
  const token =
    /'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\/|(?<![\w$".])(?:data_service|"data_service")\s*\.\s*|"(?:""|[^"])*"|\$([1-9]\d*)/gi;
  const prepared = sql.replace(token, (match, position: string | undefined) => {
    if (/^(?:data_service|"data_service")\s*\./i.test(match)) return "";
    if (!position) return match.startsWith("--") || match.startsWith("/*") ? " " : match;
    const value = values[Number(position) - 1];
    const name = `gea_p${position}`;
    return Array.isArray(value)
      ? `ARRAY[${value.map((item, index) => scalar(`${name}_${index}`, item)).join(", ")}]`
      : scalar(name, value);
  });
  const code = prepared.replace(token, " ").trim();
  if (
    !/^(SELECT|WITH)\b/i.test(code) ||
    /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE|CALL|COPY)\b/i.test(
      code,
    ) ||
    /;\s*\S/.test(code)
  ) {
    throw new GeaSqlError("GEA_SQL_READ_ONLY_REQUIRED", "业务数据接口只允许单条只读查询", 400);
  }
  return { sql: prepared.replace(/;\s*$/, ""), parameters };
}

/** Same governed-SQL pagination contract as the existing GEA sales workbench. */
export function geaSqlPageRequest(
  prepared: ReturnType<typeof prepareGeaSql>,
  pageNo: number,
  pageSize: number,
  includeTotal: boolean,
) {
  if (
    !Number.isSafeInteger(pageNo) ||
    pageNo < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 200 ||
    !Number.isSafeInteger((pageNo - 1) * pageSize)
  )
    throw new GeaSqlError("GEA_SQL_PARAMETER_INVALID", "业务查询分页大小无效", 400);
  let name = "fc_page";
  while (
    Object.hasOwn(prepared.parameters, name + "_limit") ||
    Object.hasOwn(prepared.parameters, name + "_offset")
  )
    name += "_";
  return {
    sql: prepared.sql + `\nLIMIT :${name}_limit OFFSET :${name}_offset`,
    parameters: {
      ...prepared.parameters,
      [name + "_limit"]: pageSize,
      [name + "_offset"]: (pageNo - 1) * pageSize,
    },
    includeTotal,
  };
}

function record(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rowsFrom(payload: unknown): Row[] | null {
  if (Array.isArray(payload)) return payload.every(record) ? payload : null;
  if (!record(payload)) return null;
  for (const key of ["rows", "records", "list", "data", "result"]) {
    if (key in payload) {
      const rows = rowsFrom(payload[key]);
      if (rows) return rows;
    }
  }
  return null;
}

function totalFrom(payload: unknown): number | null {
  if (!record(payload)) return null;
  const total =
    payload.total === null || payload.total === undefined || payload.total === ""
      ? NaN
      : Number(payload.total);
  if (Number.isSafeInteger(total) && total >= 0) return total;
  for (const key of ["data", "result"]) {
    const total = totalFrom(payload[key]);
    if (total !== null) return total;
  }
  return null;
}

function columnMetadata(payload: unknown): ColumnMetadata {
  if (!record(payload)) return {};
  const nested = columnMetadata(payload.result ?? payload.data);
  for (const key of ["returnedColumns", "rejectedColumns"] as const) {
    if (Array.isArray(payload[key])) nested[key] = payload[key];
  }
  return nested;
}

function failureFrom(payload: unknown): Row | undefined {
  if (!record(payload)) return;
  if (record(payload.failure)) return payload.failure;
  return failureFrom(payload.result ?? payload.data);
}

// 凭据只由 Web 服务端提供。每页重新取凭据，失效或拒绝后不回退直连 PG。
export function createGeaSqlDatabase(
  delegationToken: () => string,
  transport: { endpoint: string; signal: AbortSignal; fetch?: typeof fetch; limit?: SqlReadLimit },
): BusinessDatabase {
  async function execute(
    sql: string,
    values: unknown[] = [],
    options: QueryOptions = { pageSize: 200 },
  ) {
    const prepared = options.configured ?? prepareGeaSql(sql, values);
    const { pageSize } = options;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new GeaSqlError("GEA_SQL_PARAMETER_INVALID", "业务查询分页大小无效", 400);
    }
    const fetchPage = async (pageNo: number, includeTotal: boolean) => {
      transport.signal.throwIfAborted();
      if (transport.limit && pageNo > transport.limit.maxPages)
        throw new GeaSqlError("GEA_SQL_PAGE_LIMIT", "业务查询页数超过本次读取上限", 400);
      const token = delegationToken();
      if (!token)
        throw new GeaSqlError(
          "GEA_GATEWAY_SESSION_REJECTED",
          "GEA 会话已失效，请重新进入应用",
          401,
        );
      transport.limit?.beforeRequest();
      const target = transport.endpoint;
      const configured = Number(
        process.env.GEA_SQL_QUERY_TIMEOUT_SECONDS ??
          process.env.GEA_SQL_REQUEST_TIMEOUT_SECONDS ??
          "30",
      );
      const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured * 1000 : 30_000;
      let payload: unknown;
      let metadata: ColumnMetadata = {};
      try {
        const response = await (transport.fetch ?? fetch)(target, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "X-Delegation-Token": token,
            "X-Request-Id": randomUUID(),
          },
          body: JSON.stringify(
            options.configured ??
              geaSqlPageRequest(
                prepared as ReturnType<typeof prepareGeaSql>,
                pageNo,
                pageSize,
                includeTotal,
              ),
          ),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([transport.signal, AbortSignal.timeout(timeoutMs)]),
        });
        const body: unknown = await response.json().catch(() => null);
        transport.signal.throwIfAborted();
        const responseCode =
          record(body) && typeof body.code === "number" ? body.code : response.status;
        if (
          !response.ok ||
          !record(body) ||
          body.success === false ||
          failureFrom(body)?.reasonCode ||
          responseCode < 200 ||
          responseCode >= 300
        ) {
          const safeDiagnostic = new GeaResponseError(response.status, body, [token]);
          const upstreamCode = record(body)
            ? [
                body.errorCode,
                failureFrom(body)?.reasonCode,
                body.code,
                body.message,
                body.msg,
              ].find((value) => typeof value === "string" && /^[A-Z][A-Z0-9_]{2,127}$/.test(value))
            : null;
          // This endpoint authenticates with a delegated token. A bare 401
          // therefore means the delegation can be renewed; a 403 remains a
          // genuine access decision and must not trigger a retry.
          const rejected =
            response.status === 401 ||
            (typeof upstreamCode === "string" &&
              /^(AI_GATEWAY_SESSION_(MAX_LIFETIME_EXCEEDED|EXPIRED|REVOKED|NOT_FOUND)|GEA_GATEWAY_SESSION_REJECTED)$/.test(
                upstreamCode,
              ));
          const denied = response.status === 403;
          const failure = new GeaSqlError(
            rejected
              ? "GEA_GATEWAY_SESSION_REJECTED"
              : typeof upstreamCode === "string"
                ? upstreamCode
                : denied
                  ? "GEA_SQL_PERMISSION_DENIED"
                  : "GEA_SQL_QUERY_FAILED",
            rejected
              ? "GEA 会话已失效，请重新进入应用"
              : denied
                ? "当前用户没有该业务数据的 GEA 读取权限"
                : "GEA SQL 查询失败（" +
                  (upstreamCode ??
                    (response.ok
                      ? responseCode >= 400
                        ? `业务码 ${responseCode}`
                        : "GEA_SQL_QUERY_FAILED"
                      : safeDiagnostic.code)) +
                  "）" +
                  (safeDiagnostic.message === safeDiagnostic.code
                    ? ""
                    : "：" + safeDiagnostic.message.slice(safeDiagnostic.code.length + 1)),
            rejected ? 401 : response.ok ? 503 : response.status,
            !rejected &&
              !/^(RESOURCE_NOT_PUBLISHED|FIELD_NOT_PUBLISHED|NO_RETURN_COLUMN_ALLOWED|RETURN_PERMISSION_DENIED)$/.test(
                String(upstreamCode),
              ) &&
              (response.status === 429 || response.status >= 500),
          );
          Object.assign(failure, {
            failure: safeDiagnostic.details.failure,
            gatewayErrorCode: safeDiagnostic.details.upstreamCode,
            returnedColumns: columnMetadata(body).returnedColumns,
            rejectedColumns: columnMetadata(body).rejectedColumns,
          });
          throw failure;
        }
        if (!("result" in body))
          throw new GeaSqlError("GEA_SQL_RESPONSE_INVALID", "GEA SQL 查询返回格式无效", 502, true);
        payload = body.result;
        metadata = columnMetadata(body);
      } catch (error) {
        transport.signal.throwIfAborted();
        if (error instanceof GeaSqlError) throw error;
        const timeout =
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new GeaSqlError(
          timeout ? "GEA_SQL_QUERY_TIMEOUT" : "GEA_SQL_UNAVAILABLE",
          timeout ? "GEA SQL 查询超时" : "GEA SQL 查询服务暂时不可用",
          503,
          true,
        );
      }
      const pageRows = rowsFrom(payload);
      if (!pageRows)
        throw new GeaSqlError("GEA_SQL_RESPONSE_INVALID", "GEA SQL 查询返回格式无效", 502, true);
      if (options.configured && record(payload)) {
        if (payload.complete === false || payload.truncated === true || payload.hasMore === true)
          throw new GeaSqlError(
            "GEA_SQL_RESULT_INCOMPLETE",
            "GEA SQL 返回被截断，未生成完整结果",
            502,
          );
        if (
          "rowCount" in payload &&
          (!Number.isSafeInteger(payload.rowCount) || payload.rowCount !== pageRows.length)
        )
          throw new GeaSqlError("GEA_SQL_RESPONSE_INVALID", "GEA SQL 返回行数不一致", 502);
      }
      const total = totalFrom(payload);
      if (
        transport.limit &&
        (pageRows.length > transport.limit.maxRows ||
          (total !== null && total > transport.limit.maxRows))
      )
        throw new GeaSqlError("GEA_SQL_RESULT_LIMIT", "业务查询结果超过本次读取上限", 400);
      // A single-page query never fetches the remaining counted pages.
      if (
        transport.limit &&
        options.pageNo === undefined &&
        total !== null &&
        Math.ceil(total / pageSize) > transport.limit.maxPages
      )
        throw new GeaSqlError("GEA_SQL_PAGE_LIMIT", "业务查询页数超过本次读取上限", 400);
      if (includeTotal && total === null)
        throw new GeaSqlError("GEA_SQL_RESPONSE_INVALID", "GEA SQL 计数页缺少总数", 502, true);
      // Validate metadata whenever supplied; older compatible envelopes may nest only rows/total.
      if (!options.configured && record(payload))
        for (const [key, expected] of Object.entries({
          pageNo,
          pageSize,
          offset: (pageNo - 1) * pageSize,
        })) {
          if (key in payload && (payload[key] === null || Number(payload[key]) !== expected))
            throw new GeaSqlError("GEA_SQL_RESPONSE_INVALID", "GEA SQL 分页位置不匹配", 502, true);
        }
      return { rows: pageRows, total, ...metadata };
    };
    if (options.configured) {
      // The installed query owns LIMIT/OFFSET and its paired count. Exactly one physical request.
      const result = await fetchPage(1, false);
      return result;
    }
    if (options.pageNo !== undefined) return fetchPage(options.pageNo, true);
    const first = await fetchPage(1, true),
      total = first.total;
    if (total === null) {
      if (first.rows.length < pageSize) return { ...first, rows: first.rows };
      throw new GeaSqlError("GEA_SQL_RESULT_INCOMPLETE", "GEA SQL 分页结果不完整", 502, true);
    }
    const pageCount = Math.ceil(total / pageSize);
    if (total > 200000)
      throw new GeaSqlError("GEA_SQL_RESULT_TOO_LARGE", "GEA SQL 查询结果超过读取上限", 502);
    const validate = (page: typeof first, pageNo: number) => {
      if (JSON.stringify(columnMetadata(page)) !== JSON.stringify(columnMetadata(first)))
        throw new GeaSqlError(
          "GEA_SQL_COLUMN_PERMISSION_CHANGED",
          "查询期间字段权限发生变化，请重新查询",
          403,
        );
      if (page.total !== null && page.total !== total)
        throw new GeaSqlError(
          "GEA_SQL_PAGINATION_CHANGED",
          "查询期间数据发生变化，请重试",
          503,
          true,
        );
      if (page.rows.length !== Math.min(pageSize, Math.max(0, total - (pageNo - 1) * pageSize)))
        throw new GeaSqlError("GEA_SQL_RESULT_INCOMPLETE", "GEA SQL 分页结果不完整", 502, true);
      return page.rows;
    };
    const rows = validate(first, 1);
    // Bounded reads preserve page order; the final counted page checks for changes after all earlier pages.
    for (let start = 2; start < pageCount; start += 4) {
      const numbers = Array.from(
        { length: Math.min(4, pageCount - start) },
        (_, index) => start + index,
      );
      const pages = await Promise.all(
        numbers.map(async (number) => validate(await fetchPage(number, false), number)),
      );
      rows.push(...pages.flat());
    }
    if (pageCount > 1) rows.push(...validate(await fetchPage(pageCount, true), pageCount));
    return { rows, ...columnMetadata(first) };
  }
  async function query(
    sql: string,
    values: unknown[] = [],
    options: QueryOptions = { pageSize: 200 },
  ) {
    const started = performance.now();
    let rows: number | undefined;
    try {
      const result = await execute(sql, values, options);
      rows = result.rows.length;
      return result;
    } finally {
      if (process.env.DSH_GEA_MODE === "1")
        console.info(
          "dsh-query-timing",
          JSON.stringify({
            stage: sql.match(/\/\*\s*(branch:[a-z0-9-]+)\s*\*\//)?.[1] ?? "gea-sql",
            ms: Math.round(performance.now() - started),
            rows,
          }),
        );
    }
  }
  async function queryPackedRows(sql: string, values: unknown[], packing: RowPacking) {
    // Validate the original fixed SQL before composing the trusted grouping query.
    prepareGeaSql(sql, values);
    return unpackBusinessRows((await query(packedRowsSql(sql, packing), values)).rows);
  }
  return {
    query,
    queryConfigured: (request) =>
      execute(request.sql, [], { pageSize: 200, pageNo: 1, configured: request }),
    queryWithOptions: query,
    queryPackedRows,
    queryPage: (sql, values, pageNo, pageSize) => execute(sql, values, { pageNo, pageSize }),
  };
}
