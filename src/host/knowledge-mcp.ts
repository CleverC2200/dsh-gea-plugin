/** WeKnora business results are answers and citations, never Cube datasets or reusable authorization grants. */
import { withMcpTrace, type GatewayTrace } from "./mcp-trace.ts";
export const KNOWLEDGE_SOURCE = "mcp.weknora";
export const KNOWLEDGE_METHODS = ["weknora_list_knowledge_bases", "weknora_ask"] as const;
type KnowledgeMethod = (typeof KNOWLEDGE_METHODS)[number];

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function invalid(field: string, payload?: unknown, gatewayTrace: GatewayTrace = {}): Error {
  const envelope = record(payload);
  const body = record(envelope?.result) ?? envelope;
  const ids = Object.fromEntries(
    ["requestId", "traceId", "auditId"].flatMap((key) => {
      const value = envelope?.[key] ?? body?.[key];
      return typeof value === "string" ? [[key, value]] : [];
    }),
  );
  return withMcpTrace(
    Object.assign(
      Error(
        `GEA_KNOWLEDGE_RESULT_INVALID: 知识响应的 ${field} 不符合约定，未取得可信答案。保留请求标识核对服务端结果，不自动重试。` +
          Object.entries(ids)
            .map(([key, value]) => ` ${key}=${value}`)
            .join(""),
      ),
      {
        code: "GEA_KNOWLEDGE_RESULT_INVALID",
        category: "RESPONSE_CONTRACT",
        retryable: false,
        ...ids,
      },
    ),
    gatewayTrace,
  );
}

/** Enforce the documented knowledge arguments without rewriting questions or selecting a different identity. */
export function knowledgeArguments(method: KnowledgeMethod, args: Record<string, unknown>): void {
  const allowed = method === "weknora_ask" ? ["query", "knowledgeBaseIds"] : [];
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    throw Error("GEA_KNOWLEDGE_ARGUMENTS_INVALID: 仅接受当前知识工具的业务参数。");
  if (method === "weknora_list_knowledge_bases") return;
  if (!nonempty(args.query) || args.query.length > 4000)
    throw Error("GEA_KNOWLEDGE_ARGUMENTS_INVALID: query 必须是1至4000字符的完整问题。");
  const ids = args.knowledgeBaseIds;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 20 ||
    !ids.every(nonempty) ||
    new Set(ids).size !== ids.length
  )
    throw Error(
      "GEA_KNOWLEDGE_ARGUMENTS_INVALID: knowledgeBaseIds 必须是1至20个不同的 GEA 知识库 ID。",
    );
}

export function knowledgeSelection(catalog: string, args: Record<string, unknown>): void {
  const payload: unknown = JSON.parse(catalog);
  const envelope = record(payload);
  const libraries = Array.isArray(payload) ? payload : envelope?.result;
  if (!Array.isArray(libraries)) throw invalid("knowledgeBases", payload);
  const available = new Set(libraries.map((item: unknown) => record(item)?.id));
  const selected = Array.isArray(args.knowledgeBaseIds) ? args.knowledgeBaseIds : [];
  const unavailable = selected.filter((id: unknown) => !available.has(id));
  if (unavailable.length)
    throw Object.assign(
      Error(
        `GEA_KNOWLEDGE_SELECTION_REQUIRED: 所选知识库当前不可问答，请从当前 ASK 目录重新选择，不按名称替换历史 ID。不可用 ID=${JSON.stringify(unavailable)} 当前目录=${catalog}`,
      ),
      { code: "GEA_KNOWLEDGE_SELECTION_REQUIRED", retryable: false },
    );
}

/** Prefer the structured business result; text-only peers must supply exactly one business JSON value. */
export function knowledgeResult(
  method: KnowledgeMethod,
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  stringify: (value: unknown) => string,
  parseText: (text: string) => unknown,
  gatewayTrace: GatewayTrace = {},
): string {
  let payload: unknown = result.structuredContent;
  if (payload === undefined || payload === null) {
    const candidates: unknown[] = [];
    if (Array.isArray(result.content))
      for (const part of result.content) {
        const entry = record(part);
        if (entry?.type !== "text" || typeof entry.text !== "string") continue;
        const candidate = parseText(entry.text);
        if (Array.isArray(candidate) || record(candidate)) candidates.push(candidate);
      }
    if (candidates.length !== 1) throw invalid("content.text", undefined, gatewayTrace);
    [payload] = candidates;
  }
  const envelope = record(payload);
  const wrapped = envelope !== undefined && Object.hasOwn(envelope, "result");
  if (wrapped && (envelope.success !== true || envelope.code !== "SUCCESS"))
    throw invalid("success/code", payload, gatewayTrace);
  const body = wrapped ? envelope.result : payload;
  if (method === "weknora_list_knowledge_bases") {
    if (!Array.isArray(body)) throw invalid("knowledgeBases", payload, gatewayTrace);
    const seen = new Set<string>();
    const askable = body.filter((item: unknown) => {
      const library = record(item);
      if (
        !library ||
        !nonempty(library.id) ||
        !nonempty(library.name) ||
        !Array.isArray(library.actions) ||
        !library.actions.every((action: unknown) => typeof action === "string") ||
        seen.has(library.id)
      )
        throw invalid("knowledgeBases.id/name/actions", payload, gatewayTrace);
      seen.add(library.id);
      return library.actions.includes("ASK");
    });
    return stringify(wrapped ? { ...envelope, result: askable } : askable);
  }
  const answer = record(body);
  if (
    !answer ||
    answer.status !== "COMPLETED" ||
    !nonempty(answer.answer) ||
    !Array.isArray(answer.references)
  )
    throw invalid("status/answer/references", payload, gatewayTrace);
  const selected = Array.isArray(args.knowledgeBaseIds) ? args.knowledgeBaseIds : [];
  for (const item of answer.references) {
    const reference = record(item);
    if (
      !reference ||
      !nonempty(reference.knowledgeBaseId) ||
      !selected.includes(reference.knowledgeBaseId)
    )
      throw invalid("references.knowledgeBaseId", payload, gatewayTrace);
  }
  Object.assign(answer, {
    geaCompletion: {
      status: "UNKNOWN",
      reason: "SERVER_COMPLETION_UNVERIFIED",
      message: "尚未取得可验证的生成结束依据，正文和引用的完成度未知，不能报告完整成功。",
    },
  });
  if (Object.keys(gatewayTrace).length) Object.assign(envelope ?? answer, { gatewayTrace });
  return stringify(payload);
}
