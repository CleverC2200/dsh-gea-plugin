import { createHash } from "node:crypto";

/** Hash the exact input values independently of JSON key order or whitespace. */
export function forecastInputHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Only complete JSON actually submitted by the user proves a pure calculation's source.
 * Tool results, plugin injections and a model's data_mode declaration grant nothing.
 */
export function hasUserForecastInput(
  messages: readonly unknown[],
  digest: string,
): boolean {
  for (const message of messages) {
    const value = message as { source?: { kind?: string }; content?: unknown };
    if (value.source?.kind !== "user" || !Array.isArray(value.content))
      continue;
    for (const block of value.content) {
      if (
        block.type !== "text" ||
        typeof block.text !== "string" ||
        block.text.length > 8_000_000
      )
        continue;
      const text = block.text;
      let start = -1,
        depth = 0,
        quoted = false,
        escaped = false;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (start < 0) {
          if (char === "{") {
            start = i;
            depth = 1;
          }
          continue;
        }
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) {
          try {
            const input = JSON.parse(text.slice(start, i + 1));
            if (
              ["provided", "mock"].includes(input.data_mode) &&
              forecastInputHash(input) === digest
            )
              return true;
          } catch {
            /* Incomplete or non-JSON prose is not source evidence. */
          }
          start = -1;
        }
      }
    }
  }
  return false;
}
