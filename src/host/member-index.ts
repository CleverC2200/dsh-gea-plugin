/**
 * 语义模型成员清单（宿主侧索引）：发查询前校验成员名。
 *
 * 线上实测（2026-09-23，requestId d6f0b66f / bc916472）：模型把业务词直接当成员名发出去
 * （"品类" → `agents_scm_safety_stock.category_name`），而这个 cube 里的真名是
 * `product_categ_name`。网关把下游的 "member not found" 裹成 `MCP_UPSTREAM_TOOL_ERROR`，
 * 模型和我们两边都拿不到真实原因，只能反复重试。
 *
 * 提示词里"成员名照抄目录"约束过很多次都没用：实测模型会在**同一个回合**里并行发
 * "读目录"和"发查询"，查询参数在目录结果回来之前就定型了。所以这里在宿主侧兜一道：
 * 清单在手就逐字校验 dimensions/measures/filters/order，不认识的成员**不发出去**，
 * 就地告诉模型真名是什么。
 */
import { didYouMean } from "../shared/name-lookup.ts";

export type ModelMembers = {
  dimensions: string[];
  measures: string[];
  segments: string[];
};

type MemberIndex = Map<string, ModelMembers>;

/** 清单缓存：模型定义一天内基本不动，10 分钟足够；过期后重新读一次目录。 */
const INDEX_TTL_MS = 10 * 60 * 1000;
const MAX_SUGGESTIONS = 3;
const MAX_LISTED_MEMBERS = 24;

let cached: { at: number; models: MemberIndex } | undefined;

/** `模型.字段` 拆两半；不是这个形状（没有点、点在首尾）就不管。 */
function splitMember(member: string): { model: string; field: string } | undefined {
  const at = member.lastIndexOf(".");
  if (at <= 0 || at === member.length - 1) return undefined;
  return { model: member.slice(0, at), field: member.slice(at + 1) };
}

function memberNames(value: unknown, model: string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const name =
        typeof item === "string"
          ? item
          : typeof (item as { name?: unknown })?.name === "string"
            ? ((item as { name: string }).name)
            : "";
      const trimmed = name.trim();
      if (!trimmed) return "";
      // 有的产物只给短名，补上模型前缀，校验时统一按全名比。
      return trimmed.includes(".") ? trimmed : `${model}.${trimmed}`;
    })
    .filter(Boolean);
}

/** 把 inspect 产物（`{"semanticModel":[…]}`）压成 模型名 → 成员清单。 */
export function memberIndexFrom(payload: unknown): MemberIndex {
  const models = (payload as { semanticModel?: unknown })?.semanticModel;
  const index: MemberIndex = new Map();
  if (!Array.isArray(models)) return index;
  for (const model of models) {
    const name = (model as { name?: unknown })?.name;
    if (typeof name !== "string" || !name.trim()) continue;
    index.set(name.trim(), {
      dimensions: memberNames((model as { dimensions?: unknown }).dimensions, name),
      measures: memberNames((model as { measures?: unknown }).measures, name),
      segments: memberNames((model as { segments?: unknown }).segments, name),
    });
  }
  return index;
}

/** 记住一份清单（目录工具每次读完 inspect 都会调一次）。 */
export function rememberMemberIndex(payload: unknown): void {
  const models = memberIndexFrom(payload);
  if (models.size > 0) cached = { at: Date.now(), models };
}

/** 当前可用的清单；没有或过期返回 undefined（这时不拦，交给失败回填）。 */
export function memberIndex(): MemberIndex | undefined {
  if (!cached) return undefined;
  if (Date.now() - cached.at > INDEX_TTL_MS) {
    cached = undefined;
    return undefined;
  }
  return cached.models;
}

export function forgetMemberIndex(): void {
  cached = undefined;
}

/** 查询里引用到的全部成员名：dimensions/measures/segments/filters.member/order 键。 */
export function queryMembers(queries: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(queries)) return out;
  const takeFilters = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const filter of value) {
      const member = (filter as { member?: unknown })?.member;
      if (typeof member === "string" && member.trim()) out.push(member.trim());
      takeFilters((filter as { and?: unknown })?.and);
      takeFilters((filter as { or?: unknown })?.or);
    }
  };
  for (const item of queries) {
    const query = (item as { query?: unknown })?.query;
    if (!query || typeof query !== "object") continue;
    const record = query as Record<string, unknown>;
    for (const key of ["dimensions", "measures", "segments"]) {
      const list = record[key];
      if (Array.isArray(list))
        for (const member of list)
          if (typeof member === "string" && member.trim()) out.push(member.trim());
    }
    takeFilters(record.filters);
    const order = record.order;
    if (order && typeof order === "object" && !Array.isArray(order))
      for (const member of Object.keys(order))
        if (member.trim()) out.push(member.trim());
    if (Array.isArray(order))
      for (const entry of order)
        if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].trim())
          out.push(entry[0].trim());
  }
  return [...new Set(out)];
}

/** 模型名对了、字段名不在清单里的成员（模型不在清单里时不判——那是模型名或权限的事）。 */
export function unknownMembers(
  members: readonly string[],
  index: MemberIndex,
): string[] {
  const out: string[] = [];
  for (const member of members) {
    const parts = splitMember(member);
    if (!parts) continue;
    const model = index.get(parts.model);
    if (!model) continue;
    const known = new Set([...model.dimensions, ...model.measures, ...model.segments]);
    if (!known.has(member) && !known.has(parts.field)) out.push(member);
  }
  return out;
}

/** 被写进 measures、但其实是维度的成员（上游一定会拒，实测把数值维度写进 measures 就整批被拒）。 */
export function misplacedMeasures(queries: unknown, index: MemberIndex): string[] {
  const out: string[] = [];
  if (!Array.isArray(queries)) return out;
  for (const item of queries) {
    const query = (item as { query?: unknown })?.query;
    const measures = (query as { measures?: unknown })?.measures;
    if (!Array.isArray(measures)) continue;
    for (const member of measures) {
      if (typeof member !== "string") continue;
      const parts = splitMember(member.trim());
      if (!parts) continue;
      const model = index.get(parts.model);
      if (!model) continue;
      const isMeasure = model.measures.includes(member.trim()) || model.measures.includes(parts.field);
      const isDimension =
        model.dimensions.includes(member.trim()) || model.dimensions.includes(parts.field);
      if (!isMeasure && isDimension) out.push(member.trim());
    }
  }
  return [...new Set(out)];
}

/** 同一个模型里最像的真名（只在成员名写错时用）。 */
export function memberSuggestion(
  member: string,
  index: MemberIndex,
): string | undefined {
  const parts = splitMember(member);
  if (!parts) return undefined;
  const model = index.get(parts.model);
  if (!model) return undefined;
  // 只比字段名：全名里的模型前缀人人相同，放进去会把相似度摊平。
  const candidates = [...model.dimensions, ...model.measures, ...model.segments].map((name) => {
    const field = name.split(".").pop() ?? name;
    return { id: name, fields: [{ text: field, label: "成员名", identity: true }] };
  });
  const hint = didYouMean(parts.field, candidates);
  if (!hint) return undefined;
  // didYouMean 的文案是「没有直接叫「X」的标识；最像的是 「Y」…」——要取"最像"的那个。
  const found = /最像的是\s*「([^」]+)」/.exec(hint);
  return found?.[1] ?? undefined;
}

/**
 * 写错成员名时的提示：说清"没有这个成员 + 最像的是哪个 + 这个模型有哪些成员"。
 * 这是唯一能让模型自己改对的信息——网关那边只会回一句"下游工具执行失败"。
 */
export function memberHint(
  unknown: readonly string[],
  index: MemberIndex,
): string {
  const lines: string[] = [
    `GEA_CUBE_MEMBER_UNKNOWN：这些成员名不在目录里（查询没有发出去）：${unknown.join("、")}。`,
  ];
  for (const member of unknown.slice(0, MAX_SUGGESTIONS)) {
    const suggestion = memberSuggestion(member, index);
    if (suggestion) lines.push(`- ${member} → 最像的是 ${suggestion}`);
  }
  // 受影响的模型各列一次可用成员，模型照着抄就能改对。
  const listed = new Set<string>();
  for (const member of unknown) {
    const parts = splitMember(member);
    const model = parts ? index.get(parts.model) : undefined;
    if (!parts || !model || listed.has(parts.model)) continue;
    listed.add(parts.model);
    lines.push(`- ${parts.model} 现有成员：${memberListFor(model, parts.model)}`);
  }
  lines.push(
    "成员名必须逐字来自目录（业务词要和成员名对上，别自己翻译）；改好参数再发一次。",
  );
  return lines.join("\n");
}

/** 该模型"有哪些成员"的一句话（清单太长时截断，并说清截断了）。 */
function memberListFor(model: ModelMembers, modelName: string): string {
  const all = [...model.dimensions, ...model.measures, ...model.segments];
  const shown = all.slice(0, MAX_LISTED_MEMBERS).join("、");
  return all.length > MAX_LISTED_MEMBERS
    ? `${shown} …（共 ${all.length} 个，完整的用 gea_gateway_catalog 带 model=${modelName} 再看一次）`
    : shown;
}

/** 把数值维度写进 measures 时的提示。 */
export function measureHint(
  misplaced: readonly string[],
  index: MemberIndex,
  queries: unknown,
): string {
  const modelName = splitMember(misplaced[0] ?? "")?.model ?? "";
  const model = modelName ? index.get(modelName) : undefined;
  const measures = model?.measures ?? [];
  // 这一次查询里已经用了的正确度量（模型可能只是多塞了一个维度进去）。
  const used = queryMembers(queries).filter((member) => measures.includes(member));
  return (
    `GEA_CUBE_MEASURE_MISMATCH：${misplaced.join("、")} 是**维度**，不能写进 measures（上游会拒掉整批查询）。` +
    (measures.length
      ? `${modelName} 里能写进 measures 的成员只有：${measures.join("、")}。`
      : `${modelName} 没有定义任何度量：所有成员——包括数值字段——都只能放 dimensions，合计只能取回行以后自己汇总（并按快照/月份/版本把口径钉到唯一）。`) +
    (used.length ? `这次查询里用对的度量：${used.join("、")}。` : "") +
    "改好参数再发一次。"
  );
}
