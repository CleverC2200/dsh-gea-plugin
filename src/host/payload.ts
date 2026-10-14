/** 在外部 JSON 输入边界接纳一个对象。 */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_PAYLOAD");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new Error("INVALID_SELECTION");
  return value;
}

export function keys(payload: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(payload).some((key) => !allowed.includes(key)))
    throw new Error("INVALID_PAYLOAD");
}
