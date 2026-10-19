import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { makeRequest, QueryContractError } from "@cleverc2200/dsh-agent-workbench/configured-query";
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
    const { queryId, parameters } = input as { queryId?: unknown; parameters?: unknown };
    if (
      typeof queryId !== "string" ||
      !/^[a-z][a-z0-9_.-]{0,119}$/.test(queryId) ||
      !parameters ||
      typeof parameters !== "object" ||
      Array.isArray(parameters)
    )
      throw Object.assign(Error("配置查询参数无效"), { code: "INVALID_CONFIGURED_QUERY" });
    if (resource.manifest.sqlConfig !== "sql.config.json") throw Error("INVALID_SQL_CONFIG_PATH");
    const root = await realpath(resource.directory);
    const path = await realpath(resolve(root, "sql.config.json"));
    if (!path.startsWith(root + sep)) throw Error("INVALID_SQL_CONFIG_PATH");
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > 5_000_000) throw Error("SQL_CONFIG_TOO_LARGE");
    const config = JSON.parse(raw);
    if (
      config.schemaVersion !== 1 ||
      config.agentId !== resource.manifest.id ||
      !config.queries ||
      typeof config.queries !== "object" ||
      Array.isArray(config.queries)
    )
      throw Error("INVALID_AGENT_SQL_CONFIG");
    const request = makeRequest(config, queryId, parameters as Record<string, unknown>);
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
  } catch (error: any) {
    signal.throwIfAborted();
    // A structured business result survives both the HTTP owner and MessageChannel bridges.
    const known = error instanceof GeaSqlError || error instanceof QueryContractError;
    const code =
      typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,127}$/.test(error.code)
        ? error.code
        : /^[A-Z][A-Z0-9_]{1,127}$/.test(error?.message ?? "")
          ? error.message
          : "CONFIGURED_QUERY_FAILED";
    return {
      success: false,
      errorCode: known && error.gatewayErrorCode ? error.gatewayErrorCode : code,
      message: known ? error.message : "配置查询失败（" + code + "）",
      ...(known
        ? {
            failure: error.failure,
            returnedColumns: error.returnedColumns,
            rejectedColumns: error.rejectedColumns,
          }
        : {}),
    };
  }
}
