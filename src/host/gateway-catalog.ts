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
