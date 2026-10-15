/**
 * 业务词 → 机器标识的通用查找：模型名、成员名、工具名、配方 id、技能名都用这一套。
 *
 * 线上反复翻车的是同一件事：模型拿人话去找标识（`model="库龄"`、`tool="查库存"`、
 * `recipe="缺货汇总"`），宿主只做「名字子串相等」，对不上就回一串裸清单或直接报错。
 * 中文尤其吃亏——同一个意思常有几种写法（库龄/货龄、缺货/缺口），子串永远对不上，
 * 于是模型开始猜名字，一轮打十几次调用还没答。
 *
 * 这里**不为任何具体词写映射**，只给一套语言无关的相似度排序：
 *   完全相等 > 前缀 > 子串 > 字符 bigram 重合 + 单字覆盖率 + 文本是否够短。
 * 不依赖分词（中文没有词边界），也不需要同义词表——换成任何业务词都成立。
 * 排序结果怎么用由调用方决定：给明细、给"你要找的是不是…"，还是给完整清单。
 */

/** 候选里的一段可匹配文本。 */
export type NameField = {
  /** 参与匹配的原文。 */
  text: string;
  /** 归类（模型名／说明／成员名／工具名…）：命中时回给模型，说明"为什么给你这个"。 */
  label: string;
  /** 标识本身：命中它比"在长说明里凑出的相似"更可信，排序时优先。 */
  identity?: boolean;
};

export type NameCandidate = {
  /** 机器标识：模型名、工具名、配方 id… */
  id: string;
  /** 这个标识下所有可被搜到的文本。 */
  fields: readonly NameField[];
};

export type NameMatch = {
  id: string;
  /** 0~1，越大越像。 */
  score: number;
  /** 命中的那段文本。 */
  field: NameField;
};

/** 完全相等 / 前缀 / 子串，这三个是"字面就对上"，不需要相似度兜底。 */
const EQUAL = 1;
const PREFIX = 0.9;
const SUBSTRING = 0.8;
/** 模糊分支的及格线：查询里的字至少有一半（按稀有度加权）能在文本里找到，否则是长文本造成的巧合。 */
const COVERAGE_FLOOR = 0.5;
/** 标识本身命中比说明命中更可信，给一点加成。 */
const IDENTITY_BONUS = 1.05;
/** 默认及格线：模糊分支的满配分是 0.55+0.35+0.1=1，0.35 能收下"靠覆盖率硬凑"的候选。 */
const DEFAULT_MIN_SCORE = 0.35;
/** 语料里根本没出现过的字：当"很稀有"算，不要因为它把整句的覆盖率摊薄。 */
const RARE_WEIGHT = 3;

/** 每个字有多稀有（idf 式权重）：常见字（库、日）说明不了什么，稀有字（龄、缺）才是线索。 */
type CharWeights = ReadonlyMap<string, number>;

/**
 * 从语料里算出每个字的稀有度：一个字在越多段文本里出现越不值钱。
 * 中文没有分词，靠这个替代"词频"——不许要词典，也不为任何业务词写映射。
 */
function charWeights(texts: readonly string[]): CharWeights {
  const documents = texts.filter(Boolean);
  const seen = new Map<string, number>();
  for (const text of documents)
    for (const char of new Set(text)) seen.set(char, (seen.get(char) ?? 0) + 1);
  const total = documents.length || 1;
  return new Map([...seen].map(([char, count]) => [char, Math.log(1 + total / count)]));
}

/** 归一化：只留字母、数字与汉字，大小写/下划线/空格一律抹平。 */
export function normalizeTerm(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 字符 bigram 集合；只有一个字时就是它自己。 */
function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  if (text.length === 1) {
    out.add(text);
    return out;
  }
  for (let index = 0; index + 2 <= text.length; index += 1)
    out.add(text.slice(index, index + 2));
  return out;
}

/** Dice 系数：查得越像越接近 1；长文本会被稀释，所以还要看覆盖率。 */
function bigramDice(query: string, text: string): number {
  const left = bigrams(query);
  const right = bigrams(text);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * 查询里的字有多少能在文本里找到（按稀有度加权）：同义不同字（库龄 vs 货龄）只能靠这个兜。
 * 命中一个稀有字（龄）比命中一个满篇都是的字（库/日）有用得多。
 */
function charCoverage(query: string, text: string, weights?: CharWeights): number {
  const wanted = new Set(query);
  if (wanted.size === 0) return 0;
  const chars = new Set(text);
  let hit = 0;
  let weight = 0;
  for (const char of wanted) {
    const value = weights?.get(char) ?? RARE_WEIGHT;
    weight += value;
    if (chars.has(char)) hit += value;
  }
  return weight === 0 ? 0 : hit / weight;
}

/**
 * 一段文本与查询的相似度（已归一化的字符串上算）。
 * 字面命中直接给分；否则用 bigram 重合 + 单字覆盖率 + 文本够不够短（短文本更像"就是这个"）。
 */
export function textSimilarity(query: string, text: string, weights?: CharWeights): number {
  if (!query || !text) return 0;
  if (text === query) return EQUAL;
  if (text.startsWith(query)) return PREFIX;
  if (text.includes(query)) return SUBSTRING;
  const coverage = charCoverage(query, text, weights);
  if (coverage < COVERAGE_FLOOR) return 0;
  // 同样相似时，标题/短说明比长说明更可信（长说明顺口提一句别的词很常见）。
  const conciseness = Math.min(1, 12 / text.length);
  return (
    0.45 * bigramDice(query, text) +
    0.3 * coverage +
    0.15 * proximity(query, text) +
    0.1 * conciseness
  );
}

/**
 * 查询里的字在这段文本里挤得有多紧：挤在一起（"批次货龄日"）比散落全篇更像"这段就是在讲它"。
 * 滑动窗口找覆盖住所有出现过的查询字的最短一段，再按查询长度归一。
 */
function proximity(query: string, text: string): number {
  const wanted = new Set(query);
  const hits: Array<{ char: string; at: number }> = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (wanted.has(char)) hits.push({ char, at });
  }
  if (hits.length === 0) return 0;
  const spread = new Set(hits.map((hit) => hit.char)).size;
  const counts = new Map<string, number>();
  let covered = 0;
  let left = 0;
  let shortest = Number.POSITIVE_INFINITY;
  for (let right = 0; right < hits.length; right += 1) {
    const current = hits[right]!;
    const seen = (counts.get(current.char) ?? 0) + 1;
    counts.set(current.char, seen);
    if (seen === 1) covered += 1;
    while (covered === spread) {
      const first = hits[left]!;
      shortest = Math.min(shortest, current.at - first.at + 1);
      const left1 = (counts.get(first.char) ?? 1) - 1;
      counts.set(first.char, left1);
      if (left1 === 0) covered -= 1;
      left += 1;
    }
  }
  if (!Number.isFinite(shortest)) return 0;
  // 窗口 ≤ 查询长度的两倍就算"挤在一起"，再长按比例衰减。
  return Math.min(1, (query.length * 2) / shortest);
}

/**
 * 把候选按"像的程度"排好；每个候选只取它最像的那段文本。
 * 查询为空、或没有一个够像时返回空数组——由调用方决定怎么回话。
 */
export function rankByName(
  query: string,
  candidates: readonly NameCandidate[],
  options: { limit?: number; minScore?: number } = {},
): NameMatch[] {
  const normalized = normalizeTerm(query);
  if (!normalized) return [];
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  // 归一化只做一次；顺便统计"每个字有多少段文本用到"，给稀有字加权。
  const pool = candidates.map((candidate) => ({
    id: candidate.id,
    fields: candidate.fields.map((field) => ({ field, text: normalizeTerm(field.text ?? "") })),
  }));
  const weights = charWeights(pool.flatMap((entry) => entry.fields.map((item) => item.text)));
  const matches: NameMatch[] = [];
  for (const candidate of pool) {
    let best: NameMatch | undefined;
    for (const field of candidate.fields) {
      if (!field.text) continue;
      let score = textSimilarity(normalized, field.text, weights);
      if (score <= 0) continue;
      if (field.field.identity) score = Math.min(1, score * IDENTITY_BONUS);
      if (score < minScore) continue;
      if (!best || score > best.score) best = { id: candidate.id, score, field: field.field };
    }
    if (best) matches.push(best);
  }
  // 同样像的时候，命中在更短的那段文本里更可信（标题/成员名 > 长说明）。
  return matches
    .sort(
      (left, right) =>
        right.score - left.score || left.field.text.length - right.field.text.length,
    )
    .slice(0, options.limit ?? 5);
}

/**
 * "你要找的是不是…"：标识猜错时给一句可读的下一步。
 * 没有像的就回空串，调用方照常列可用项。
 */
export function didYouMean(
  query: string,
  candidates: readonly NameCandidate[],
  options: { label?: string; limit?: number; minScore?: number } = {},
): string {
  const matches = rankByName(query, candidates, {
    limit: options.limit ?? 3,
    ...(options.minScore === undefined ? {} : { minScore: options.minScore }),
  });
  if (matches.length === 0) return "";
  const names = matches
    .map((match) => `「${match.id}」${match.field.identity ? "" : `（${match.field.label}命中）`}`)
    .join("、");
  return `没有直接叫「${query}」的${options.label ?? "标识"}；最像的是 ${names}。`;
}
