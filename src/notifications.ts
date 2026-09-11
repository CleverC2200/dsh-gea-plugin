/** Browser-safe projection of the GEA notification API; no actions are executed here. */
export interface NotificationItem {
  id: string;
  title: string | null;
  summary: string | null;
  state: string | null;
  kind: string | null;
  eventType: string | null;
  aggregateId: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  source: {
    type: string | null;
    ref: string | null;
    label: string | null;
  } | null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("NOTIFICATION_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function optional(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    throw new Error("NOTIFICATION_INVALID_RESPONSE");
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("NOTIFICATION_INVALID_RESPONSE");
  return value;
}

/** Project a returned item and reject a detail whose identity differs from the request. */
export function notificationDetail(
  value: unknown,
  expectedId?: string,
): NotificationItem {
  const row = record(value);
  if (
    typeof row.id !== "string" ||
    !row.id ||
    (expectedId !== undefined && row.id !== expectedId)
  )
    throw new Error("NOTIFICATION_INVALID_RESPONSE");
  const source = row.source == null ? null : record(row.source);
  return {
    id: row.id,
    title: optional(row.title),
    summary: optional(row.summary),
    state: optional(row.state),
    kind: optional(row.kind),
    eventType: optional(row.event_type),
    aggregateId: optional(row.aggregate_id),
    expiresAt: optional(row.expires_at),
    createdAt: optional(row.created_at),
    source: source
      ? {
          type: optional(source.type),
          ref: optional(source.ref),
          label: optional(source.label),
        }
      : null,
  };
}

/** Preserve server totals and refuse duplicates or inconsistent paging instead of hiding missing records. */
export function notificationPage(value: unknown, pageSize: number) {
  const row = record(value);
  if (!Array.isArray(row.items))
    throw new Error("NOTIFICATION_INVALID_RESPONSE");
  const items = row.items.map((item) => notificationDetail(item));
  const total = count(row.total);
  if (
    items.length > pageSize ||
    items.length > total ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw new Error("NOTIFICATION_INVALID_RESPONSE");
  return {
    items,
    total,
    unreadCount: count(row.unread_count),
    pageSize,
    coverage: items.length === total ? "complete" : "partial",
  };
}
