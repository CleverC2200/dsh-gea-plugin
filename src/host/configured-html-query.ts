import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { Business } from "./business.ts";
import { GeaSqlError } from "../html-sql.ts";

/** Query IDs are resolved from this installed page only. The page never supplies SQL or routing. */
export async function readConfiguredHtmlQuery(
  resource: { directory: string; manifest: Record<string, any> },
  input: unknown,
  business: Pick<Business, "pluginSql">,
  signal: AbortSignal,
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
      Object.keys(input).some((key) => !["queryId", "parameters"].includes(key))
    )
      throw Object.assign(Error("配置查询只接受查询 ID 和业务参数"), {
        code: "INVALID_CONFIGURED_QUERY",
      });
    const query = input as { queryId?: unknown; parameters?: unknown };
    const candidateId = query.queryId;
    const candidateParameters = query.parameters;
    if (
      typeof candidateId !== "string" ||
      !/^[a-z][a-z0-9_.-]{0,119}$/.test(candidateId) ||
      !candidateParameters ||
      typeof candidateParameters !== "object" ||
      Array.isArray(candidateParameters)
    )
      throw Object.assign(Error("配置查询参数无效"), { code: "INVALID_CONFIGURED_QUERY" });
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
    // Published-resource and field authorization remain with the GEA gateway.
    // No local provider is consulted on this path, including after a denied query.
    const result = await business.pluginSql(
      { ...request, consumerCode: resource.manifest.gea.consumerCode },
      signal,
      true,
    );
    signal.throwIfAborted();
    return { ...(result as object), configVersion: createHash("sha256").update(raw).digest("hex") };
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
  return { success: false, errorCode: code, message: "配置查询失败（" + code + "）" };
}
