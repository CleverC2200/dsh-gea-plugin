/** 面向浏览器的 GEA 通知 API 安全投影；此处不会执行任何动作。 */
export interface NotificationItem {
  id: string;
  interactionRequestId: string | null;
  title: string | null;
  summary: string | null;
  body: string | null;
  content: string | null;
  state: string | null;
  kind: string | null;
  eventType: string | null;
  businessType: string | null;
  notifiedAt: string | null;
  actionType: string | null;
  actionText: string | null;
  version: number | null;
  dismissible: boolean | null;
  aggregateId: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  source: {
    type: string | null;
    ref: string | null;
    label: string | null;
  } | null;
  target: { type: string | null; value: string | null } | null;
  approval: {
    instanceId: string | null;
    actions: string[];
    actionable: boolean | null;
    bizKey: string | null;
    version: number | null;
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
function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
function optionalBoolean(value: unknown): boolean | null {
  return value === null || value === undefined ? null : typeof value === "boolean" ? value : null;
}

/** 投影返回的通知项；详情身份与请求不一致时拒绝返回。 */
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
    interactionRequestId: optional(row.interaction_request_id),
    title: optional(row.title),
    summary: optional(row.summary),
    body: optional(row.content ?? row.body),
    content: optional(row.content ?? row.body),
    state: optional(row.state),
    kind: optional(row.kind),
    eventType: optional(row.event_type),
    businessType: optional(row.business_type),
    notifiedAt: optional(row.notified_at),
    actionType: optional(row.action_type),
    actionText: optional(row.action_text),
    version: optionalNumber(row.version),
    dismissible: optionalBoolean(row.dismissible),
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
    target: row.target == null ? null : (() => {
      const target = record(row.target);
      return { type: optional(target.type), value: optional(target.value) };
    })(),
    approval: row.approval == null ? null : (() => {
      const approval = record(row.approval);
      return {
        instanceId: optional(approval.instance_id),
        actions: Array.isArray(approval.actions) && approval.actions.every((item) => typeof item === "string") ? approval.actions as string[] : [],
        actionable: optionalBoolean(approval.actionable),
        bizKey: optional(approval.biz_key),
        version: optionalNumber(approval.version),
      };
    })(),
  };
}

/** 保留服务端总数；遇到重复记录或分页不一致时拒绝隐藏缺失数据。 */
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
