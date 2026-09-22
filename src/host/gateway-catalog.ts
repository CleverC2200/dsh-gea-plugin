/** GEA 网关语义模型的紧凑目录：把 inspect 产物压到模型能一次读完的大小。 */

/** 从 MCP 工具结果里取出文本。 */
export function contentText(message: unknown): string {
  const content = (message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/**
 * 工具结果的可用正文：优先 text 片段，没有就把整条结果序列化。
 * inspect 的产物可能以 resource_link 形式返回，地址只在 JSON 里。
 */
export function resultText(message: unknown): string {
  const text = contentText(message);
  if (text.trim()) return text;
  // resources/read 的返回是 { contents: [{ uri, mimeType, text }] }，与工具结果不同。
  const contents = (message as { contents?: Array<{ text?: string }> } | undefined)?.contents;
  if (Array.isArray(contents)) {
    const joined = contents
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
    if (joined.trim()) return joined;
  }
  try {
    return JSON.stringify(message) ?? "";
  } catch {
    return "";
  }
}

/** 结果里引用的 data-artifact 资源地址。 */
export function extractArtifactUri(text: string): string | undefined {
  return /data-artifact:\/\/[^\s)"'\\]+/.exec(text)?.[0];
}

/** 结果被宿主截断时，完整正文落在本机 spill 文件里；返回该路径。 */
export function spillPathFrom(text: string): string | undefined {
  const match = /stored at:\s*(\/[^\s)]+)/.exec(text);
  // 路径后面常紧跟句号或逗号，去掉尾部标点。
  return match?.[1]?.replace(/[.,;:]+$/, "");
}

/** 解析第一段完整 JSON 对象：工具结果常常是 JSON + 尾部提示文本。 */
export function parseFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("GEA_CATALOG_NOT_JSON");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  throw new Error("GEA_CATALOG_TRUNCATED");
}

type Member = { name?: string };
type Model = {
  name?: string;
  title?: string;
  description?: string;
  dimensions?: Member[];
  measures?: Member[];
  segments?: Member[];
};

/** 语义模型里某一类成员的名字。 */
function membersOf(model: Model, key: "dimensions" | "measures" | "segments"): string[] {
  const list = model[key];
  if (!Array.isArray(list)) return [];
  return list
    .map((member) => (typeof member?.name === "string" ? member.name : undefined))
    .filter((name): name is string => Boolean(name));
}

/**
 * 把 inspect 产物压成紧凑目录：只留模型名、标题、一句说明和成员名，
 * 避免 30 万字符的正文把模型预算吃光（实测 8 个模型约 330KB，宿主只内联 30KB）。
 * @param payload inspect 返回的 {"semanticModel":[...]}。
 * @param options.model 只看某个模型（子串匹配）；不给就是全部模型（可能被截断）。
 */
export function projectCatalog(
  payload: unknown,
  options: { model?: string; maxMembersPerModel?: number; maxChars?: number } = {},
): string {
  const models = ((payload as { semanticModel?: Model[] })?.semanticModel ?? []).filter(Boolean);
  if (models.length === 0) throw new Error("GEA_CATALOG_EMPTY");
  const filter = options.model?.trim().toLowerCase();
  const maxMembers = options.maxMembersPerModel ?? 120;
  const maxChars = options.maxChars ?? 12000;
  const lines: string[] = ["GEA 网关语义模型目录（成员名可直接用于 Cube 查询，形如 模型.字段）："];
  let truncated = false;
  for (const model of models) {
    const name = model.name ?? "";
    if (!name) continue;
    if (filter && !name.toLowerCase().includes(filter)) continue;
    const dimensions = membersOf(model, "dimensions");
    const measures = membersOf(model, "measures");
    const segments = membersOf(model, "segments");
    const parts = [`- ${name}${model.title && model.title !== name ? `（${model.title}）` : ""}`];
    const description = (model.description ?? "").replace(/\s+/g, " ").trim();
    if (description) parts.push(`  说明：${description.slice(0, 160)}`);
    if (dimensions.length) parts.push(`  维度(${dimensions.length})：${dimensions.slice(0, maxMembers).join(", ")}`);
    if (measures.length) parts.push(`  度量(${measures.length})：${measures.slice(0, maxMembers).join(", ")}`);
    if (segments.length) parts.push(`  分段(${segments.length})：${segments.slice(0, maxMembers).join(", ")}`);
    if (dimensions.length > maxMembers || measures.length > maxMembers || segments.length > maxMembers)
      truncated = true;
    const block = parts.join("\n");
    if (lines.join("\n").length + block.length > maxChars) {
      truncated = true;
      break;
    }
    lines.push(block);
  }
  if (lines.length === 1) throw new Error(`GEA_CATALOG_MODEL_NOT_FOUND: ${options.model ?? ""}`);
  if (truncated) lines.push("（目录已截断：需要某个模型的完整成员名时，带 model=模型名 再调一次。）");
  return lines.join("\n");
}
