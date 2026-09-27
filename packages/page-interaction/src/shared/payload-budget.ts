/**
 * 给模型看的载荷压缩：**不要上下文爆炸**。
 *
 * 线上实测：一张分仓库存页的元素目录 19.8KB 被写进工具说明，每次请求都要付一次；
 * 页面上下文 17KB 还被重复拉了三次。规则改成本文件：小载荷原样过；带 focus 就只留
 * 命中的行/字段；超过预算就退成"摘要（数量 + 字段名 + 极少量样本）"，并如实标注
 * 省略了多少、怎么再取。绝不因为"太大"整条丢掉，也绝不带与问题无关的明细。
 *
 * 纯函数，不认识任何业务。
 */

/** 单次进模型上下文的默认预算（字节）。 */
export const MODEL_PAYLOAD_BUDGET = 12_000;
const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MAX_CHARS = 200;
/** 摘要默认不带样本行：先给字段名，需要哪一行再按 focus 取。 */
const DEFAULT_SAMPLE_ITEMS = 0;

const byteLength = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/** 从用户问题/模型给的 focus 里切出关键词；太短的词没有区分度，直接丢。 */
export function focusTokens(focus?: string): string[] {
  if (typeof focus !== "string") return [];
  return [
    ...new Set(
      focus
        .split(/[\s,，、;；|]+/)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length >= 2),
    ),
  ].slice(0, 8);
}

function includesFocus(value: unknown, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  let text: string;
  try {
    text = JSON.stringify(value)?.toLowerCase() ?? "";
  } catch {
    return false;
  }
  return tokens.some((token) => text.includes(token));
}

export const truncateText = (value: string, maxChars: number): string =>
  value.length > maxChars ? value.slice(0, maxChars) + "…" : value;

type Narrowed = { value: unknown; omitted: number };

/** 递归收窄：数组按 focus 过滤 + 限长，字符串截断，对象逐键处理。 */
function narrow(
  value: unknown,
  tokens: string[],
  options: { maxItems: number; maxChars: number },
): Narrowed {
  if (typeof value === "string")
    return { value: truncateText(value, options.maxChars), omitted: 0 };
  if (value === null || typeof value !== "object") return { value, omitted: 0 };
  if (Array.isArray(value)) {
    const matched = value.filter((item) => includesFocus(item, tokens));
    const kept = matched.slice(0, options.maxItems);
    // 省略数按"原数组里没进上下文"的条数算：既包括没命中 focus 的，也包括超出上限的。
    const omitted = value.length - kept.length;
    return {
      value: kept.map((item) => narrow(item, tokens, options).value),
      omitted,
    };
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let omitted = 0;
  for (const key of Object.keys(source)) {
    const child = narrow(source[key], tokens, options);
    result[key] = child.value;
    omitted += child.omitted;
  }
  return { value: result, omitted };
}

/** 无 focus 又超预算时的摘要：只给数量、字段名与极少量样本。 */
function brief(value: unknown, maxChars: number, sampleItems: number): unknown {
  if (typeof value === "string") return truncateText(value, maxChars);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const fields = [
      ...new Set(
        value
          .slice(0, 5)
          .flatMap((item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? Object.keys(item as Record<string, unknown>)
              : [],
          ),
      ),
    ].slice(0, 20);
    return {
      count: value.length,
      ...(fields.length ? { fields } : {}),
      sample: value
        .slice(0, sampleItems)
        .map((item) => brief(item, maxChars, sampleItems)),
    };
  }
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source).map((key) => [
      key,
      brief(source[key], maxChars, sampleItems),
    ]),
  );
}

export type CompressedPayload = {
  /** 可以直接交给模型的 JSON 字符串。 */
  json: string;
  /** 有没有压缩过。 */
  compressed: boolean;
  /** 被略过的条目数（行/元素）。 */
  omitted: number;
  /** 需要告诉模型的取数提示；没压缩时为 undefined。 */
  note?: string;
};

/**
 * 压到预算内。
 *
 * 顺序：① 原样（小载荷 + 无 focus）；② 按 focus 收窄；③ 摘要；
 * ④ 仍然超预算就继续减少样本与字段长度，最后至少还有 key 结构。
 */
export function compressForModel(
  payload: unknown,
  options: {
    budgetBytes?: number;
    focus?: string;
    maxItems?: number;
    maxChars?: number;
  } = {},
): CompressedPayload {
  const budget = options.budgetBytes ?? MODEL_PAYLOAD_BUDGET;
  const tokens = focusTokens(options.focus);
  let maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  let maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const original = byteLength(payload);
  if (tokens.length === 0 && original <= budget)
    return { json: JSON.stringify(payload), compressed: false, omitted: 0 };

  const attempt = (): Narrowed =>
    tokens.length > 0
      ? narrow(payload, tokens, { maxItems, maxChars })
      : {
          value: brief(payload, maxChars, DEFAULT_SAMPLE_ITEMS),
          omitted: 0,
        };
  let narrowed = attempt();
  let json = JSON.stringify(narrowed.value);
  // 摘要本身也可能超预算（字段极多时）：继续收紧，直到落在预算内。
  while (byteLength(json) > budget && (maxItems > 1 || maxChars > 60)) {
    if (maxItems > 1) maxItems = Math.max(1, Math.floor(maxItems / 2));
    else maxChars = Math.max(60, Math.floor(maxChars / 2));
    narrowed = attempt();
    json = JSON.stringify(narrowed.value);
  }
  const omitted = narrowed.omitted;
  const note = [
    tokens.length > 0
      ? `已按 focus「${tokens.join(" ")}」只保留相关行/字段`
      : "已只保留摘要（数量与字段名）",
    omitted > 0 ? `另有 ${omitted} 条未展开` : undefined,
    "需要更多明细时带上更具体的 focus（用户提到的对象或字段名），不要重复整屏拉取。",
  ]
    .filter((text): text is string => text !== undefined)
    .join("；");
  return { json, compressed: true, omitted, note };
}
