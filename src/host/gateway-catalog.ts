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

/**
 * 从资源/工具结果里找 `rows` 数组（inline_complete 的返回形状可能被包一层）。
 * 只认第一处，够用；找不到就返回 null。
 */
export function rowsFromPayload(payload: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(payload))
    return payload.every((row) => row !== null && typeof row === "object")
      ? (payload as Array<Record<string, unknown>>)
      : null;
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const direct = rowsFromPayload(record.rows ?? record.records ?? record.data ?? record.result ?? []);
  return direct;
}

/** 工具返回的文本里夹着 JSON 时，取出里面的 rows。 */
export function rowsFromText(text: string): Array<Record<string, unknown>> | null {
  const parsed = parseFirstJsonObject(text);
  return rowsFromPayload(parsed);
}

/**
 * 把样例值排成人读的清单：模型查之前先看一眼"这一列长什么样"，
 * 就不会再把 `2026-10` 当日期、把 `202608` 当完整日期。
 */
export function formatSampleValues(
  rows: readonly Record<string, unknown>[],
  members: readonly string[],
): string {
  if (rows.length === 0)
    return "没有取到样例值（该模型在当前身份下可能没有数据，或这些成员都为空）。";
  const first = rows[0] ?? {};
  const lines = members.map((member) => {
    const value = first[member];
    return `- ${member} = ${value === undefined ? "（该行没有这个字段）" : JSON.stringify(value)}`;
  });
  return [
    `成员样例值（取 1 行，共 ${members.length} 个成员）：`,
    ...lines,
    "查询里请照这些值的格式写：时间是完整日期（如 2026-10-01），文本年月是哪几位就写哪几位（如 202608）。",
  ].join("\n");
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

type Member = { name?: string; type?: string };
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
  return memberEntriesOf(model, key).map((entry) => entry.name);
}

/**
 * 成员名 + 类型。inspect 产物里每个成员都带 `type`（string/time/number/boolean），
 * 我们以前只留名字，导致模型不知道哪个是日期（于是把 `2026-10` 当日期传）、
 * 哪个是 number 类型的维度（于是塞进 measures 被拒）。这里把类型带出来。
 */
function memberEntriesOf(
  model: Model,
  key: "dimensions" | "measures" | "segments",
): Array<{ name: string; type?: string }> {
  const list = model[key];
  if (!Array.isArray(list)) return [];
  return list
    .map((member) => {
      const name = typeof member?.name === "string" ? member.name : undefined;
      if (!name) return undefined;
      const type = typeof member?.type === "string" ? member.type.trim().toLowerCase() : undefined;
      return type ? { name, type } : { name };
    })
    .filter((entry): entry is { name: string; type?: string } => Boolean(entry));
}

/**
 * 给成员名标类型。只标 time/number/boolean：
 * - `string` 是绝大多数（854 个成员里 474 个），标了纯占字节，不标；
 * - `[time]` 是这次最要紧的：看到它就知道"值要写成完整日期"。
 */
const typeTag = (entry: { name: string; type?: string }): string => {
  const type = entry.type;
  if (type === "time") return `${entry.name}[time]`;
  if (type === "number") return `${entry.name}[number]`;
  if (type === "boolean") return `${entry.name}[bool]`;
  return entry.name;
};

/** 标好类型的成员名清单，供明细与索引共用。 */
function taggedMembers(
  model: Model,
  key: "dimensions" | "measures" | "segments",
): string[] {
  return memberEntriesOf(model, key).map(typeTag);
}

/** 该模型的时间/数值成员数量：索引里用一句短话提示"这个模型要小心格式"。 */
function typedCounts(model: Model): { time: number; number: number } {
  const all = [
    ...memberEntriesOf(model, "dimensions"),
    ...memberEntriesOf(model, "measures"),
    ...memberEntriesOf(model, "segments"),
  ];
  return {
    time: all.filter((entry) => entry.type === "time").length,
    number: all.filter((entry) => entry.type === "number").length,
  };
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
    const measures = membersOf(model, "measures").length;
    const typed = typedCounts(model);
    return (
      `- ${model.name}` +
      (description ? `  说明：${description.slice(0, 120)}` : "") +
      `  维度 ${membersOf(model, "dimensions").length} / 度量 ${measures} / 分段 ${membersOf(model, "segments").length}` +
      // 线上实测：模型把数值字段（如 agents_scm_inventory_age.qty）写进 measures，
      // 而这些 cube 一个 measure 都没定义，上游直接拒掉整批查询计划。
      (measures === 0 ? "（无度量：所有成员都是维度，只放 dimensions）" : "") +
      (typed.time > 0 ? `（含 ${typed.time} 个时间成员，取值要完整日期）` : "")
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
      "（成员放 dimensions 还是 measures 由这里的类型决定：只有列在“度量”里的成员才写进 measures；标了“无度量”的模型一律放 dimensions。）",
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
    "成员放 dimensions 还是 measures 由下面的类型决定：只有在“度量”里列出的成员才写进 measures。",
    "成员名后的 [time] 是时间成员：取值要写完整日期（如 2026-10-01）；[number] 只是数值类型的维度，仍然放在 dimensions 里。",
  ];
  let membersTruncated = false;
  for (const model of models) {
    const name = model.name ?? "";
    const dimensions = taggedMembers(model, "dimensions");
    const measures = taggedMembers(model, "measures");
    const segments = taggedMembers(model, "segments");
    const parts = [`- ${name}${model.title && model.title !== name ? `（${model.title}）` : ""}`];
    const description = (model.description ?? "").replace(/\s+/g, " ").trim();
    if (description) parts.push(`  说明：${description.slice(0, 160)}`);
    if (dimensions.length)
      parts.push(`  维度(${dimensions.length})：${dimensions.slice(0, options.maxMembers).join(", ")}`);
    if (measures.length)
      parts.push(`  度量(${measures.length})：${measures.slice(0, options.maxMembers).join(", ")}`);
    else
      // 一个 measure 都没有的 cube：数值字段也是维度，写进 measures 会被上游拒掉整批查询。
      parts.push("  度量：无（这个模型没有定义 measure：所有成员一律放 dimensions，数值字段也不要写进 measures）");
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
