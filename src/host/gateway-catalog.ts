/** GEA 网关语义模型的紧凑目录：把 inspect 产物压到模型能一次读完的大小。 */
import { monthEncoding, salesQueryGuide } from "./sales-result-contract.ts";

import {
  rankByName,
  type NameCandidate,
  type NameField,
  type NameMatch,
} from "../shared/name-lookup.ts";

/** 从 MCP 工具结果里取出文本。 */
export function contentText(message: unknown): string {
  const content = (message as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
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

/**
 * 结果里引用的 data-artifact 资源地址。
 * 注意：宿主自己内联的那段是 `【结果内容 data-artifact://…#】`，所以中文右括号也要当分隔符，
 * 否则地址会带上 `】` 去读资源，网关直接回 "Resource 不存在"。
 */
export function extractArtifactUri(text: string): string | undefined {
  return /data-artifact:\/\/[^\s)"'\\】」）》]+/.exec(text)?.[0];
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
  const direct = rowsFromPayload(
    record.rows ?? record.records ?? record.data ?? record.result ?? [],
  );
  return direct;
}

/**
 * 制品形状（resource 模式）里的行：`queryArtifact.resources[].contents[].text` 是**逐页转义的
 * JSON**（datasetName + rows）。规约 §13.3 要求适配器把这一层解开——不解析就只能看到
 * "有制品、没有行"，线上会把这种情况误报成"取不到样例值"，也会让"取值可用性"账本永远是空的。
 */
function rowsFromArtifact(payload: unknown): Array<Record<string, unknown>> | null {
  const resources = (payload as { queryArtifact?: { resources?: unknown } })?.queryArtifact
    ?.resources;
  if (!Array.isArray(resources)) return null;
  const rows: Array<Record<string, unknown>> = [];
  for (const resource of resources) {
    const contents = (resource as { contents?: unknown })?.contents;
    if (!Array.isArray(contents)) continue;
    for (const content of contents) {
      const inner = (content as { text?: unknown })?.text;
      if (typeof inner !== "string") continue;
      let page: unknown;
      try {
        page = JSON.parse(inner);
      } catch {
        continue;
      }
      const pageRows = rowsFromPayload(page);
      if (pageRows?.length) rows.push(...pageRows);
    }
  }
  return rows.length ? rows : null;
}

/** 工具返回的文本里夹着 JSON 时，取出里面的 rows（顶层形状和制品形状都认）。 */
export function rowsFromText(text: string): Array<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = parseFirstJsonObject(text);
  } catch {
    return null;
  }
  const direct = rowsFromPayload(parsed);
  if (direct?.length) return direct;
  return rowsFromArtifact(parsed) ?? direct;
}

/** 样本观察只描述本次返回，不从少量空值推断整张表不可用。 */
export function noteMemberSamples(
  notes: Map<string, string>,
  rows: readonly Record<string, unknown>[],
  dimensions: readonly string[],
): void {
  for (const member of dimensions) {
    if (!member.includes(".")) continue;
    const values = rows.map((row) => row[member]).filter((value) => value !== undefined);
    if (!values.length) continue;
    const unique = [
      ...new Set(
        values.filter((value) => value !== null && String(value).trim() !== "").map(String),
      ),
    ];
    notes.delete(member);
    if (!unique.length)
      notes.set(member, `本次 ${values.length} 行样本均为空；不能据此断定全量为空`);
    else if (unique.length === 1)
      notes.set(
        member,
        `本次 ${values.length} 行样本只见「${unique[0].slice(0, 20)}」；不代表全量分布`,
      );
    while (notes.size > 200) notes.delete(notes.keys().next().value!);
  }
}

/** 对无观察标注的缓存正文补上最新观察；成员名已在目录中不代表已有观察。 */
export function appendMemberSamples(
  text: string,
  notes: ReadonlyMap<string, string>,
  model?: string,
): string {
  const selected = [...notes].filter(([member]) => !model || member.startsWith(`${model}.`));
  if (!selected.length) return text;
  return (
    text +
    "\n取值观察（仅本轮样本）：" +
    selected
      .slice(0, 6)
      .map(([member, note]) => `${member} — ${note}`)
      .join("；")
  );
}

/**
 * 把样例值排成人读的清单：模型查之前先看一眼"这一列长什么样"，
 * 就不会再把 `2026-10` 当日期、把 `202608` 当完整日期。
 */
export function formatSampleValues(
  samples: readonly {
    member: string;
    rows: readonly Record<string, unknown>[];
  }[],
): string {
  const lines = samples.map(({ member, rows }) => {
    const values = [
      ...new Set(
        rows
          .map((row) => row[member])
          .filter((value) => value !== undefined)
          .map((value) => JSON.stringify(value)),
      ),
    ];
    if (values.length === 0) return `- ${member} = 本次样本未返回可见值（不能推断整表为空）`;
    const shown = values.slice(0, 5);
    const extra =
      values.length === 1 && values[0] === '""'
        ? "　← 本次样本只有空串，不能据此判断全量缺失"
        : values.length === 1
          ? "　← 本次样本只有一个取值"
          : "";
    return `- ${member} = ${shown.join("、")}${extra}`;
  });
  const anyValue = samples.some((sample) => sample.rows.length > 0);
  if (!anyValue)
    return [
      "这次没取到样例值：宿主没读到结果（制品没拿到），或者成员名不对——**不能据此断言「这张表没有数据或没有这个维度」**。",
      "确认办法：用 gea_module_mcp 直接查一行（dimensions=[该成员] + limit 1）看有没有值；确认没有就如实说明缺哪一项，不要再换模型/换成员试样例值。",
      ...lines,
    ].join("\n");
  return [
    "成员真实取值（每个成员最多列 5 个，按取值分布取，不是随便一行）：",
    ...lines,
    "照这些值的格式写查询：日期/时间成员写完整日期（如 2026-10-01）；文本年月是哪几位就写哪几位（如 2026-08）。",
    "样例只用于确认格式和本次已观察到的值，不代表全量分布。只有一个有效值仍可如实回答；空样本不能推出整表或维度不可用。按问题范围、快照和权限完成业务查询，不反复读取同一样例。",
  ].join("\n");
}

/**
 * 从"每个成员一条具名查询"的结果里按 dataset 名取回各自的 rows。
 * 网关的 inline_complete 返回形如 `{"datasets":[{"name":"sample_0","rows":[...]}]}`；
 * 形状认不出来时返回 undefined，由调用方回退到单成员解析。
 */
export function sampleRowsByDataset(
  text: string,
  names: readonly string[],
): Map<string, Array<Record<string, unknown>>> | undefined {
  let payload: unknown;
  try {
    payload = parseFirstJsonObject(text);
  } catch {
    return undefined;
  }
  const rowsOf = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value)
      ? value.filter(
          (row): row is Record<string, unknown> => row !== null && typeof row === "object",
        )
      : [];
  const out = new Map<string, Array<Record<string, unknown>>>();
  // 形状一（inline_complete）：{"datasets":[{"name":…,"rows":[…]}]}
  const datasets = (payload as { datasets?: unknown })?.datasets;
  if (Array.isArray(datasets))
    for (const entry of datasets) {
      const name = (entry as { name?: unknown })?.name;
      if (typeof name !== "string" || !names.includes(name)) continue;
      out.set(name, rowsOf((entry as { rows?: unknown })?.rows));
    }
  // 形状二（resource 模式/制品）：queryArtifact.resources[].contents[].text 里是转义的
  // 分页 JSON（datasetName + rows）——规约 §13.3 要求适配器把这一层解开，否则只会看到
  // "有制品但没有行"，线上就把这种情况误报成"取不到样例值"了。
  const resources = (payload as { queryArtifact?: { resources?: unknown } })?.queryArtifact
    ?.resources;
  if (Array.isArray(resources))
    for (const resource of resources) {
      const contents = (resource as { contents?: unknown })?.contents;
      if (!Array.isArray(contents)) continue;
      for (const content of contents) {
        const inner = (content as { text?: unknown })?.text;
        if (typeof inner !== "string") continue;
        let page: unknown;
        try {
          page = JSON.parse(inner);
        } catch {
          continue;
        }
        const name = (page as { datasetName?: unknown })?.datasetName;
        if (typeof name !== "string" || !names.includes(name)) continue;
        out.set(name, [...(out.get(name) ?? []), ...rowsOf((page as { rows?: unknown }).rows)]);
      }
    }
  return out.size > 0 ? out : undefined;
}

/** 解析第一段完整 JSON 对象：工具结果常常是 JSON + 尾部提示文本。 */
export function parseFirstJsonObject(
  text: string,
  parse: (text: string) => unknown = JSON.parse,
): unknown {
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
      if (depth === 0) return parse(text.slice(start, index + 1));
    }
  }
  throw new Error("GEA_CATALOG_TRUNCATED");
}

/** Small factual reminder drawn only from a successful catalog, not from model guesses. */
export function catalogFactSummary(text: string): string {
  if (!text.startsWith("GEA 网关语义模型成员")) return "";
  const skuMembers = [
    ...new Set(
      text.match(/[A-Za-z_][\w]*\.(?:material_code|material_name|sku_code|sku_name)\b/g) ?? [],
    ),
  ].slice(0, 8);
  const units = text
    .split("\n")
    .filter((line) => /语义：/.test(line) && /单位/.test(line))
    .sort((a, b) => Number(/_count\b/.test(a)) - Number(/_count\b/.test(b)))
    .slice(0, 4)
    .map((line) => line.trim().slice(0, 230));
  return skuMembers.length || units.length
    ? JSON.stringify({ returnedSkuMembers: skuMembers, returnedMeasureSemantics: units })
    : "";
}
type Member = {
  name?: string;
  type?: string;
  description?: string;
  meta?: { unit?: string; ai_context?: string };
};
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
 * 保留 inspect 成员名和服务端 type，区分日期、数值维度与 measure 的输入约定。
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
function taggedMembers(model: Model, key: "dimensions" | "measures" | "segments"): string[] {
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
 * - 带 model：按名字或内容回该模型的成员名，成员超上限时只截成员，不再说"目录被截断"。
 * - 对不上时**不报错**：先给按内容最像的几个模型，实在不像就把带说明的完整索引回出去。
 *   中文业务词和模型名/说明的用词常常不是一回事，报一句"没有这个模型"只会让模型继续猜。
 *
 * 名字怎么对上是 shared/name-lookup.ts 那套通用相似度（对任何业务词都成立，不为某个词写映射）。
 *
 * @param payload inspect 返回的 {"semanticModel":[...]}。
 */
export function projectCatalog(
  payload: unknown,
  options: {
    model?: string;
    members?: readonly string[];
    maxMembersPerModel?: number;
    maxChars?: number;
    /** 模型 → consumerCode：告诉模型"这张表用哪条模块通道查"。 */
    consumers?: ReadonlyMap<string, string>;
    /** 成员取值可用性（实测）：key 形如 `模型.字段`。 */
    memberNotes?: ReadonlyMap<string, string>;
  } = {},
): string {
  const models = ((payload as { semanticModel?: Model[] })?.semanticModel ?? []).filter(
    (model) => model && typeof model.name === "string" && model.name.trim(),
  );
  if (models.length === 0) throw new Error("GEA_CATALOG_EMPTY");
  const maxChars = options.maxChars ?? 12_000;
  const consumers = options.consumers;
  const filter = options.model?.trim();
  if (!filter && !options.members?.length)
    return modelIndex(models, maxChars, consumers, options.memberNotes);
  const detailBudget = {
    maxMembers: options.maxMembersPerModel ?? 120,
    maxChars,
    members: options.members,
    ...(consumers ? { consumers } : {}),
    ...(options.memberNotes?.size ? { memberNotes: options.memberNotes } : {}),
  };
  const exact = models.filter(
    (model) =>
      model.name === filter ||
      (!filter && options.members?.some((member) => member.startsWith(model.name + "."))),
  );
  if (exact.length) return modelDetails(exact, detailBudget);
  if (!filter) return modelIndex(models, maxChars, consumers, options.memberNotes);
  const ranked = rankByName(filter, models.map(catalogCandidate), { limit: MATCH_LIMIT + 8 });
  // 一个都不像：把带说明的完整索引直接回给模型，一步挑对，省一次往返。
  if (ranked.length === 0) return missedModel(filter, models, maxChars, consumers);
  const hits = ranked.filter((match) => match.score >= HIT_SCORE);
  // 只有"内容像"（说明/成员名里出现这个词、字面并不相等）：先按最像的给明细，并说清这是匹配结果。
  if (hits.length === 0) return weakMatch(filter, models, ranked, detailBudget);
  const shown = hits.slice(0, MATCH_LIMIT);
  const rest = hits.slice(MATCH_LIMIT);
  const parts: string[] = [];
  // 靠说明/成员名命中的，要说清"为什么给你这几个"，模型才知道这不是完整名单。
  if (!shown.some((match) => match.field.identity))
    parts.push(
      `（下面的模型是「${filter}」按内容命中的：${shown
        .map((match) => `${match.id}=${match.field.label}`)
        .join("、")}。model 只填模型名（英文标识）或它的子串，别把业务词当模型名。）`,
    );
  parts.push(modelDetails(picked(models, shown), detailBudget));
  if (rest.length)
    parts.push(
      `（还有 ${rest.length} 个同样是内容命中的模型：${rest
        .slice(0, 6)
        .map((match) => match.id)
        .join("、")}${rest.length > 6 ? " 等" : ""}；要哪个带完整名字再调一次。）`,
    );
  return parts.join("\n");
}

/** 一次最多回几个模型的明细：再多会把模型自己的上下文挤爆。 */
const MATCH_LIMIT = 3;
/** 名字/说明里**字面**出现查询词——够确定，直接当命中；再低的只算"像"。 */
const HIT_SCORE = 0.8;

const MEMBER_KEYS = ["dimensions", "measures", "segments"] as const;

/** 一个模型能被搜到的全部文本：模型名、标题、说明，以及成员名（业务词可能就是某个成员）。 */
function catalogCandidate(model: Model): NameCandidate {
  const name = model.name ?? "";
  const fields: NameField[] = [{ text: name, label: "模型名", identity: true }];
  if (model.title) fields.push({ text: model.title, label: "标题" });
  if (model.description) fields.push({ text: model.description, label: "说明" });
  for (const key of MEMBER_KEYS)
    for (const member of membersOf(model, key))
      if (member) fields.push({ text: member, label: "成员名" });
  return { id: name, fields };
}

/** 按名次取出对应的模型，保持传入名次顺序。 */
function picked(models: readonly Model[], matches: readonly NameMatch[]): Model[] {
  return matches
    .map((match) => models.find((model) => model.name === match.id))
    .filter((model): model is Model => Boolean(model));
}

/** 只有"内容像"时：给最像的几个的明细 + 其余候选名，别让这一轮空手。 */
function weakMatch(
  filter: string,
  models: readonly Model[],
  ranked: readonly NameMatch[],
  budget: {
    maxMembers: number;
    maxChars: number;
    members?: readonly string[];
    consumers?: ReadonlyMap<string, string>;
    memberNotes?: ReadonlyMap<string, string>;
  },
): string {
  const shown = ranked.slice(0, 2);
  const rest = ranked.slice(2);
  return [
    `「${filter}」不是任何一个模型名：model 只填模型名（英文标识）或它的子串；业务词先不带 model 调一次看完整索引。`,
    "下面这些是按内容最像的（像的程度从高到低），先按第一个给你明细：",
    ...shown.map(
      (match) => `- ${match.id}：${match.field.label}命中「${match.field.text.slice(0, 60)}」`,
    ),
    modelDetails(picked(models, shown), budget),
    `其它候选：${rest.map((match) => match.id).join("、") || "（没有更像的了）"}`,
    "（想看全部模型：不带 model 再调一次。）",
  ].join("\n");
}

/** 一个都不像：不报错，直接把带说明的完整索引回出去。 */
function missedModel(
  filter: string,
  models: readonly Model[],
  maxChars: number,
  consumers?: ReadonlyMap<string, string>,
): string {
  return (
    `没有叫「${filter}」的模型：model 只能填模型名（英文标识）或它的子串，` +
    "说明里的用词和模型名常常不是一回事，请照下面的说明挑。\n" +
    "请从下面挑一个模型，带 model=模型名 再调一次：\n" +
    modelIndex(models, maxChars, consumers)
  );
}

/** 索引里最多列出几个度量名：再多就退回只写数量。 */
const INDEX_MEASURE_NAMES = 3;

/**
 * 度量少的时候，索引里直接把度量名写出来。
 *
 * 线上实测（session-bbd8f3be）：索引只写"度量 1"，模型看不见"金额/数量类度量不在了"，
 * 于是一连换了 6 个模型、24 步才得出结论；而同一天早些时候这张模型的度量还是 11 个。
 * 名字写出来，模型第一步就能判断"这张表能不能做合计"，不用再调一次拿明细。
 */
function measureHint(model: Model): string {
  const names = membersOf(model, "measures");
  if (names.length === 0 || names.length > INDEX_MEASURE_NAMES) return "";
  const short = names.map((name) => {
    const at = name.lastIndexOf(".");
    return at > 0 ? name.slice(at + 1) : name;
  });
  const countOnly = short.length === 1 && short[0] === "row_count";
  return (
    `（度量：${short.join("、")}` +
    (countOnly ? "；只有行数度量，不能用于金额或数量合计" : "") +
    "）"
  );
}

/** 模型索引：先给名字与一句话，够模型挑一个再要明细。 */
function modelIndex(
  models: readonly Model[],
  maxChars: number,
  consumers?: ReadonlyMap<string, string>,
  /** 成员取值可用性（实测）：带 model 的明细用，索引里只摘该模型的已知缺口。 */
  memberNotes?: ReadonlyMap<string, string>,
): string {
  const header = "GEA 网关语义模型索引（成员名可直接用于 Cube 查询，形如 模型.字段）：";
  /**
   * 该模型的已知缺口（最多两条）：把"某列实测全为空串/只有一个取值"这类结论提前写在索引里，
   * 模型第一次读索引就能排除，不用一个模型一个模型去试。
   */
  const gapHint = (model: Model): string => {
    if (!memberNotes?.size) return "";
    const prefix = `${model.name}.`;
    const hits = [...memberNotes.entries()]
      .filter(([member]) => member.startsWith(prefix))
      .map(([member, note]) => `${member.slice(prefix.length)}=${note.replace(/^本轮实测/, "")}`);
    if (!hits.length) return "";
    const shown = hits.slice(0, 2).join("；");
    return `（已知缺口：${shown}${hits.length > 2 ? `；等 ${hits.length} 项` : ""}）`;
  };
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
      measureHint(model) +
      gapHint(model) +
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
      ...(consumers?.size
        ? ["（选好模型后，明细里会给出该模型的 consumerCode——调 gea_module_mcp 时用它。）"]
        : []),
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
  models: readonly Model[],
  options: {
    maxMembers: number;
    maxChars: number;
    members?: readonly string[];
    consumers?: ReadonlyMap<string, string>;
    /** 成员取值可用性（实测）：key 形如 `模型.字段`，如"取值全为空串"。 */
    memberNotes?: ReadonlyMap<string, string>;
  },
): string {
  const lines: string[] = [
    "GEA 网关语义模型成员（可直接用于 Cube 查询，形如 模型.字段）：",
    "成员放 dimensions 还是 measures 由下面的类型决定：只有在“度量”里列出的成员才写进 measures。",
    "成员名后的 [time] 是时间成员：取值要写完整日期（如 2026-10-01）；[number] 只是数值类型的维度，仍然放在 dimensions 里。",
  ];
  let membersTruncated = false;
  for (const model of models) {
    const name = model.name ?? "";
    const selected = options.members?.length ? new Set(options.members) : undefined;
    const selectedModel = selected
      ? {
          ...model,
          ...Object.fromEntries(
            MEMBER_KEYS.map((key) => [
              key,
              (model[key] ?? []).filter((member) => selected.has(member.name ?? "")),
            ]),
          ),
        }
      : model;
    const dimensions = taggedMembers(selectedModel, "dimensions");
    const measures = taggedMembers(selectedModel, "measures");
    const segments = taggedMembers(selectedModel, "segments");
    const parts = [`- ${name}${model.title && model.title !== name ? `（${model.title}）` : ""}`];
    if (selected)
      parts.push(
        `  定向成员视图：仅展示本次请求的成员，未列出不代表不存在或无权限。该模型共${(model.dimensions ?? []).length}个维度、${(model.measures ?? []).length}个度量；要完整目录请带model不带members。`,
      );
    const description = (model.description ?? "").replace(/\s+/g, " ").trim();
    if (description) parts.push(`  说明：${description.slice(0, 160)}`);
    const consumerCode = options.consumers?.get(name);
    if (consumerCode)
      parts.push(
        `  查询通道：consumerCode=${consumerCode}（调 gea_cube_query 时带它；当前快照有资源级授权，字段与业务行范围仍需执行校验）`,
      );
    if (dimensions.length)
      parts.push(
        `  维度(${dimensions.length})：${dimensions.slice(0, options.maxMembers).join(", ")}`,
      );
    if (measures.length)
      parts.push(`  度量(${measures.length})：${measures.slice(0, options.maxMembers).join(", ")}`);
    else if (selected && (model.measures?.length ?? 0) > 0)
      parts.push(
        `  本次未选择度量；模型已有${model.measures!.length}个度量，不能据此判模型无度量。`,
      );
    else
      // 一个 measure 都没有的 cube：数值字段也是维度，写进 measures 会被上游拒掉整批查询。
      parts.push(
        "  度量：无（这个模型没有定义 measure：所有成员一律放 dimensions，数值字段也不要写进 measures）",
      );
    if (segments.length)
      parts.push(`  分段(${segments.length})：${segments.slice(0, options.maxMembers).join(", ")}`);
    const semanticMembers = selected
      ? MEMBER_KEYS.flatMap((key) => selectedModel[key] ?? [])
      : (model.measures ?? []);
    const omitted: string[] = [];
    let semanticChars = 0;
    const semantics = semanticMembers
      .filter((member) => typeof member?.name === "string")
      .sort((a, b) => Number(a.name!.endsWith("_count")) - Number(b.name!.endsWith("_count")))
      .map((member) => {
        const notes = [
          member.description,
          member.meta?.unit ? `单位：${member.meta.unit}` : undefined,
          member.meta?.ai_context,
        ].filter((text): text is string => typeof text === "string" && !!text.trim());
        const month = monthEncoding(member.name!);
        if (month)
          notes.push(
            `月份文本格式：${month.includes("-") ? "YYYY-MM（7字符）" : "YYYYMM（6字符）"}，示例${month}`,
          );
        const line = notes.length
          ? `  ${member.name} 语义：${[...new Set(notes)].join("；").replace(/\s+/g, " ")}`
          : "";
        if (
          !selected &&
          semanticChars + line.length >
            Math.max(1500, options.maxChars - parts.join("\n").length - 1500)
        ) {
          omitted.push(member.name!);
          return "";
        }
        semanticChars += line.length;
        return line;
      })
      .filter(Boolean);
    parts.push(...semantics);
    if (omitted.length)
      parts.push(
        `  另有${omitted.length}项说明未展开：${omitted.join("、")}。用gea_gateway_catalog(model="${name}", members=[所需完整成员名])定向读取。`,
      );
    const guide = salesQueryGuide(name);
    if (guide) parts.push(`  查询规则：${guide}`);
    // 实测过的"这列取不到可用值"直接写在成员清单里：省掉模型"一个模型一个模型试"的过程
    // （线上实测 session-bbd8f3be：大区列全为空串，模型换 6 个模型、24 步才得出结论）。
    if (options.memberNotes?.size) {
      const flagged = [...dimensions, ...measures, ...segments]
        .map((tagged) => tagged.replace(/\[[^\]]*\]$/, ""))
        .map((member) => ({ member, note: options.memberNotes?.get(member) }))
        .filter((item): item is { member: string; note: string } => Boolean(item.note));
      if (flagged.length)
        parts.push(
          `  取值可用性（实测）：${flagged
            .slice(0, 6)
            .map((item) => `${item.member} — ${item.note}`)
            .join("；")}`,
        );
    }
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
