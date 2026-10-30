import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { Business } from "./business.ts";
import { GeaSqlError } from "../html-sql.ts";
import { gatewaySessionExpired } from "./agent-tools.ts";
import { validateCubeQueryResult } from "./cube-new.ts";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Query IDs are resolved from this installed page only. The page never supplies SQL or routing. */
export async function readConfiguredHtmlQuery(
  resource: { directory: string; manifest: Record<string, any> },
  input: unknown,
  business: Pick<Business, "pluginSql" | "moduleMcp" | "invalidateModuleMcp">,
  signal: AbortSignal,
  consumerCode: string = resource.manifest.gea.consumerCode,
  pageRead = false,
) {
  signal.throwIfAborted();
  let raw: string;
  let config;
  let queryId: string;
  let parameters: Record<string, unknown>;
  try {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !["queryId", "parameters", "freshAfter"].includes(key))
    )
      throw Object.assign(Error("配置查询只接受查询 ID 和业务参数"), {
        code: "INVALID_CONFIGURED_QUERY",
      });
    const query = input as { queryId?: unknown; parameters?: unknown; freshAfter?: unknown };
    const candidateId = query.queryId;
    const candidateParameters = query.parameters;
    if (
      typeof candidateId !== "string" ||
      !/^[a-z][a-z0-9_.-]{0,119}$/.test(candidateId) ||
      !candidateParameters ||
      typeof candidateParameters !== "object" ||
      Array.isArray(candidateParameters)
    )
      throw Object.assign(Error("配置查询参数无效"), {
        code: "INVALID_CONFIGURED_QUERY",
      });
    if (
      query.freshAfter !== undefined &&
      (typeof query.freshAfter !== "number" ||
        !Number.isSafeInteger(query.freshAfter) ||
        query.freshAfter < 0 ||
        query.freshAfter > Date.now() + 1000)
    )
      throw Error("INVALID_QUERY_CACHE_REFRESH");
    queryId = candidateId;
    parameters = candidateParameters as Record<string, unknown>;
    if (resource.manifest.sqlConfig !== "sql.config.json") throw Error("INVALID_SQL_CONFIG_PATH");
    const root = await realpath(resource.directory);
    const path = await realpath(resolve(root, "sql.config.json"));
    if (!path.startsWith(root + sep)) throw Error("INVALID_SQL_CONFIG_PATH");
    raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > 5_000_000) throw Error("SQL_CONFIG_TOO_LARGE");
    config = JSON.parse(raw);
    if (
      config.schemaVersion !== 1 ||
      config.agentId !== resource.manifest.id ||
      !config.queries ||
      typeof config.queries !== "object" ||
      Array.isArray(config.queries)
    )
      throw Error("INVALID_AGENT_SQL_CONFIG");
  } catch (error) {
    return configuredQueryFailure(error, signal);
  }
  let contractUrl: string;
  try {
    contractUrl = import.meta.resolve("@cleverc2200/dsh-agent-workbench/configured-query");
  } catch (error) {
    signal.throwIfAborted();
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    )
      return {
        success: false,
        errorCode: "GEA_WORKBENCH_UPDATE_REQUIRED",
        message: "请先完成 Workbench 更新后再使用配置查询",
      };
    throw error;
  }
  const queryContract: typeof import("@cleverc2200/dsh-agent-workbench/configured-query") =
    await import(contractUrl);
  signal.throwIfAborted();
  try {
    const request = queryContract.makeRequest(config, queryId, parameters);
    signal.throwIfAborted();
    if ("cube" in request) {
      const args = {
        action: "query",
        response_mode: "inline_complete",
        queries: [{ name: queryId, query: request.cube }],
      };
      const client = await business.moduleMcp(consumerCode, signal);
      let payload: unknown;
      try {
        payload = JSON.parse(await client.call("query_business_data", args, signal));
      } catch (error) {
        if (!signal.aborted && gatewaySessionExpired(error))
          business.invalidateModuleMcp(consumerCode, client);
        throw error;
      }
      signal.throwIfAborted();
      validateCubeQueryResult(payload, args, "inline");
      const datasets = object(payload)?.datasets;
      const dataset = Array.isArray(datasets) ? object(datasets[0]) : undefined;
      if (!dataset || !Array.isArray(dataset.rows) || !Array.isArray(dataset.fields))
        throw Error("GEA_CUBE_NEW_QUERY_RESULT_INVALID");
      return {
        rows: dataset.rows,
        returnedColumns: dataset.fields.map((field: unknown) => object(field)?.name),
        rejectedColumns: [],
        totalRowCount: dataset.totalRowCount,
        hasMorePages: dataset.hasMorePages,
        offset: dataset.offset,
        dataStatus: dataset.dataStatus,
        warnings: dataset.warnings,
        configVersion: createHash("sha256").update(raw).digest("hex"),
      };
    }
    // Published-resource and field authorization remain with the GEA gateway.
    // No local provider is consulted on this path, including after a denied query.
    const result = await business.pluginSql(
      {
        ...request,
        consumerCode,
        ...(input && typeof input === "object" && "freshAfter" in input
          ? { cacheFreshAfter: input.freshAfter }
          : {}),
      },
      signal,
      true,
      undefined,
      queryId.startsWith("source.") ||
        queryId === config.overviewQuickStock ||
        queryId === "current-shortage.summary",
      pageRead,
    );
    signal.throwIfAborted();
    return {
      ...(result as object),
      configVersion: createHash("sha256").update(raw).digest("hex"),
    };
  } catch (error) {
    return configuredQueryFailure(error, signal, queryContract);
  }
}

function configuredQueryFailure(
  error: unknown,
  signal: AbortSignal,
  queryContract?: typeof import("@cleverc2200/dsh-agent-workbench/configured-query"),
) {
  signal.throwIfAborted();
  const errorCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : undefined;
  const code =
    typeof errorCode === "string" && /^[A-Z][A-Z0-9_]{1,127}$/.test(errorCode)
      ? errorCode
      : /^[A-Z][A-Z0-9_]{1,127}$/.test(message ?? "")
        ? message
        : "CONFIGURED_QUERY_FAILED";
  if (
    error instanceof GeaSqlError ||
    (queryContract && error instanceof queryContract.QueryContractError)
  )
    return {
      success: false,
      errorCode: error.gatewayErrorCode || code,
      message: error.message,
      failure: error.failure,
      returnedColumns: error.returnedColumns,
      rejectedColumns: error.rejectedColumns,
    };
  return {
    success: false,
    errorCode: code,
    message: "配置查询失败（" + code + "）",
  };
}
