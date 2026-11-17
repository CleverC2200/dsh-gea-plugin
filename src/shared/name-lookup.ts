export type NameField = {
  text: string;

  label: string;

  identity?: boolean;
};

export type NameCandidate = {
  id: string;

  fields: readonly NameField[];
};

export type NameMatch = {
  id: string;

  score: number;

  field: NameField;
};

const EQUAL = 1;
const PREFIX = 0.9;
const SUBSTRING = 0.8;

const COVERAGE_FLOOR = 0.5;

const IDENTITY_BONUS = 1.05;

const DEFAULT_MIN_SCORE = 0.35;

const RARE_WEIGHT = 3;

type CharWeights = ReadonlyMap<string, number>;

function charWeights(texts: readonly string[]): CharWeights {
  const documents = texts.filter(Boolean);
  const seen = new Map<string, number>();
  for (const text of documents)
    for (const char of new Set(text)) seen.set(char, (seen.get(char) ?? 0) + 1);
  const total = documents.length || 1;
  return new Map([...seen].map(([char, count]) => [char, Math.log(1 + total / count)]));
}

export function normalizeTerm(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  if (text.length === 1) {
    out.add(text);
    return out;
  }
  for (let index = 0; index + 2 <= text.length; index += 1) out.add(text.slice(index, index + 2));
  return out;
}

function bigramDice(query: string, text: string): number {
  const left = bigrams(query);
  const right = bigrams(text);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

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

export function textSimilarity(query: string, text: string, weights?: CharWeights): number {
  if (!query || !text) return 0;
  if (text === query) return EQUAL;
  if (text.startsWith(query)) return PREFIX;
  if (text.includes(query)) return SUBSTRING;
  const coverage = charCoverage(query, text, weights);
  if (coverage < COVERAGE_FLOOR) return 0;

  const conciseness = Math.min(1, 12 / text.length);
  return (
    0.45 * bigramDice(query, text) +
    0.3 * coverage +
    0.15 * proximity(query, text) +
    0.1 * conciseness
  );
}

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

  return Math.min(1, (query.length * 2) / shortest);
}

export function rankByName(
  query: string,
  candidates: readonly NameCandidate[],
  options: { limit?: number; minScore?: number } = {},
): NameMatch[] {
  const normalized = normalizeTerm(query);
  if (!normalized) return [];
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

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

  return matches
    .sort(
      (left, right) => right.score - left.score || left.field.text.length - right.field.text.length,
    )
    .slice(0, options.limit ?? 5);
}

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
