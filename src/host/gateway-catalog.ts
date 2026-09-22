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
 * 把 inspect 产物分成两级给模型，避免"看起来被截断"：
 *
 * - 不带 model：只回**模型索引**（名字 + 一行说明 + 成员数量），并保证**名字完整**——
 *   线上实测：以前把名字和成员混在一起按 12KB 砍，尾部模型名整段丢失，模型以为目录不全，
 *   于是开始猜模型名（know/knowledge/age…），一轮打了 23 次调用还没答。
 * - 带 model：回该模型的成员名（按模型名子串匹配），成员超上限时只截成员，不再说"目录被截断"。
 * - 没有匹配：报错里**列出可用模型名**，让模型直接挑，而不是继续猜。
 *
 * @param payload inspect 返回的 {"semanticModel":[...]}。
 */
export function projectCatalog(
  payload: unknown,
  options: { model?: string; maxMembersPerModel?: number; maxChars?: number } = {},
): string {
  const models = ((payload as { semanticModel?: Model[] })?.semanticModel ?? []).filter(
    (model) => model && typeof model.name === "string" && model.name.trim(),
  );
  if (models.length === 0) throw new Error("GEA_CATALOG_EMPTY");
  const filter = options.model?.trim().toLowerCase();
  const maxChars = options.maxChars ?? 12_000;
  if (!filter) return modelIndex(models, maxChars);
  const matched = models.filter((model) =>
    (model.name ?? "").toLowerCase().includes(filter),
  );
  if (matched.length === 0)
    throw new Error(
      `GEA_CATALOG_MODEL_NOT_FOUND: ${options.model ?? ""}；可用模型：${models
        .map((model) => model.name)
        .slice(0, 20)
        .join("、")}${models.length > 20 ? `（共 ${models.length} 个）` : ""}`,
    );
  return modelDetails(matched, {
    maxMembers: options.maxMembersPerModel ?? 120,
    maxChars,
  });
}

/** 模型索引：先给名字与一句话，够模型挑一个再要明细。 */
function modelIndex(models: Model[], maxChars: number): string {
  const header =
    "GEA 网关语义模型索引（成员名可直接用于 Cube 查询，形如 模型.字段）：";
  const rich = (model: Model) => {
    const description = (model.description ?? "").replace(/\s+/g, " ").trim();
    return (
      `- ${model.name}` +
      (description ? `  说明：${description.slice(0, 120)}` : "") +
      `  维度 ${membersOf(model, "dimensions").length} / 度量 ${membersOf(model, "measures").length} / 分段 ${membersOf(model, "segments").length}`
    );
  };
  const namesOnly = (model: Model) => `- ${model.name}`;
  const fit = (render: (model: Model) => string): string | undefined => {
    const lines = [header];
    let length = header.length;
    for (const model of models) {
      const line = render(model);
      if (length + line.length + 1 > maxChars) return undefined;
      lines.push(line);
      length += line.length + 1;
    }
    lines.push(
      "（要某个模型的成员名，带 model=模型名 再调一次；model 按模型名子串匹配。）",
    );
    return lines.join("\n");
  };
  return (
    fit(rich) ??
    fit(namesOnly) ??
    // 极端情况：连名字都装不下也把名字给全，模型至少知道自己有什么可选。
    [header, ...models.map(namesOnly)].join("\n")
  );
}

/** 指定模型后的明细：成员名按上限截断，但不让模型以为"目录"不完整。 */
function modelDetails(
  models: Model[],
  options: { maxMembers: number; maxChars: number },
): string {
  const lines: string[] = [
    "GEA 网关语义模型成员（可直接用于 Cube 查询，形如 模型.字段）：",
  ];
  let membersTruncated = false;
  for (const model of models) {
    const name = model.name ?? "";
    const dimensions = membersOf(model, "dimensions");
    const measures = membersOf(model, "measures");
    const segments = membersOf(model, "segments");
    const parts = [`- ${name}${model.title && model.title !== name ? `（${model.title}）` : ""}`];
    const description = (model.description ?? "").replace(/\s+/g, " ").trim();
    if (description) parts.push(`  说明：${description.slice(0, 160)}`);
    if (dimensions.length)
      parts.push(`  维度(${dimensions.length})：${dimensions.slice(0, options.maxMembers).join(", ")}`);
    if (measures.length)
      parts.push(`  度量(${measures.length})：${measures.slice(0, options.maxMembers).join(", ")}`);
    if (segments.length)
      parts.push(`  分段(${segments.length})：${segments.slice(0, options.maxMembers).join(", ")}`);
    if (
      dimensions.length > options.maxMembers ||
      measures.length > options.maxMembers ||
      segments.length > options.maxMembers
    )
      membersTruncated = true;
    lines.push(parts.join("\n"));
  }
  if (membersTruncated)
    lines.push(
      "（这个模型的成员名超过单次上限，已截断：查询时只引用上面列出的成员，或先用更细的 model 关键字再查一次。）",
    );
  return lines.join("\n");
}
