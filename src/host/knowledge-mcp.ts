/** WeKnora business results are answers and citations, never Cube datasets or reusable authorization grants. */
export const KNOWLEDGE_SOURCE = "mcp.weknora";
export const KNOWLEDGE_METHODS = ["weknora_list_knowledge_bases", "weknora_ask"] as const;
type KnowledgeMethod = (typeof KNOWLEDGE_METHODS)[number];
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function invalid(field: string, payload?: unknown): Error {
  const envelope = record(payload);
  const body = record(envelope?.result) ?? envelope;
  const ids = Object.fromEntries(
    ["requestId", "traceId", "auditId"].flatMap((key) => {
      const value = envelope?.[key] ?? body?.[key];
      return typeof value === "string" ? [[key, value]] : [];
    }),
  );
  return Object.assign(
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

/** Prefer the structured business result; text-only peers must supply exactly one business JSON value. */
export function knowledgeResult(
  method: KnowledgeMethod,
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  stringify: (value: unknown) => string,
  parseText: (text: string) => unknown,
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
    if (candidates.length !== 1) throw invalid("content.text");
    [payload] = candidates;
  }
  const envelope = record(payload);
  const wrapped = envelope !== undefined && Object.hasOwn(envelope, "result");
  if (wrapped && (envelope.success !== true || envelope.code !== "SUCCESS"))
    throw invalid("success/code", payload);
  const body = wrapped ? envelope.result : payload;
  if (method === "weknora_list_knowledge_bases") {
    if (!Array.isArray(body)) throw invalid("knowledgeBases", payload);
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
        throw invalid("knowledgeBases.id/name/actions", payload);
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
    throw invalid("status/answer/references", payload);
  const selected = Array.isArray(args.knowledgeBaseIds) ? args.knowledgeBaseIds : [];
  for (const item of answer.references) {
    const reference = record(item);
    if (
      !reference ||
      !nonempty(reference.knowledgeBaseId) ||
      !selected.includes(reference.knowledgeBaseId)
    )
      throw invalid("references.knowledgeBaseId", payload);
  }
  return stringify(payload);
}
