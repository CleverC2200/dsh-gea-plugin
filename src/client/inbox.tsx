/** GEA 消息待办：服务端掌握状态，页面只提交当前版本和幂等键。 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CopyKey } from "./locales.ts";
import type { NotificationItem } from "../shared/notifications.ts";
import type { PageNavigation } from './desktop-navigation.tsx';

type Page = {
  coverage: "complete" | "partial";
  items: NotificationItem[];
  total: number;
  unreadCount: number;
  pageSize: number;
  environment: "production" | "test";
  fetchedAt: string;
};
type Translate = (key: CopyKey) => string;

/** 列表和详情读取彼此独立；导航后到达的旧响应直接丢弃。 */
export function Inbox({ t, navigation }: { t: Translate; navigation?: PageNavigation | null }) {
  const [pageNo, setPageNo] = useState(1);
  const [state, setState] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  // 每次唤醒独立读取详情；手动选择不继续受上一条导航约束。
  const [selectedReceipt, setSelectedReceipt] = useState<string>();
  const navigationOwned = useRef(false);
  useLayoutEffect(() => {
    if (navigation?.notificationId) {navigationOwned.current=true;setDetailResult(null);setSelected(navigation.notificationId);setSelectedReceipt(navigation.receipt);}
    else if (navigationOwned.current) {navigationOwned.current=false;setSelected(null);setSelectedReceipt(undefined);setDetailResult(null);setData(null);setSelectedIds(new Set());}
  },[navigation?.receipt]);
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [data, setData] = useState<Page | null>(null);
  const [detailResult, setDetailResult] = useState<{
    id: string;
    navigationReceipt?: string;
    detail?: NotificationItem;
    error?: CopyKey;
  } | null>(null);
  const [error, setError] = useState<CopyKey | null>(null);
  const [busy, setBusy] = useState(true);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<CopyKey | null>(null);
  const attempt = useRef<object | null>(null);
  const writing = useRef(false);
  const [retryPending, setRetryPending] = useState(false);
  const refresh = () => setRevision((value) => value + 1);
  const mutate = async (payload: object) => {
    if (writing.current || (attempt.current && attempt.current !== payload)) return;
    writing.current = true;
    attempt.current = payload;
    setMutationBusy(true); setMutationError(null);
    try {
      await readNotifications(payload);
      attempt.current = null; setRetryPending(false); setSelectedIds(new Set());
      setDetailResult(null); refresh(); setDetailRevision((value) => value + 1);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "";
      const rejected = /^(NOTIFICATION_|APPROVAL_|INVALID_|LOGIN_REQUIRED|STALE_|GEA_HTTP_40[13])/.test(code);
      setRetryPending(!rejected);
      if (rejected) { attempt.current = null; setSelectedIds(new Set()); setDetailResult(null); refresh(); setDetailRevision(value => value + 1); }
      setMutationError(rejected ? notificationError(reason) : "notificationResultUnknown");
    } finally { writing.current = false; setMutationBusy(false); }
  };
  const mutationNotice = mutationError && <div role="alert"><p>{t(mutationError)}</p>{retryPending && <button disabled={mutationBusy} onClick={() => attempt.current && mutate(attempt.current)}>{t("notificationRetryOriginal")}</button>}</div>;
  useEffect(() => {
    const controller = new AbortController();
    setSelectedIds(new Set());
    setError(null);
    setBusy(true);
    void readNotifications<{ value: Page }>({ pageNo, state }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result.value);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setData(null);
          setError(notificationError(reason));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [pageNo, revision, state]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void readNotifications<{ value: { detail: NotificationItem } }>({ id: selected }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDetailResult({ id: selected, navigationReceipt:selectedReceipt, detail: result.value.detail });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setDetailResult({ id: selected, navigationReceipt:selectedReceipt, error: notificationError(reason) });
      });
    return () => controller.abort();
  }, [selected, detailRevision, selectedReceipt]);
  const currentDetail = detailResult?.id === selected && detailResult?.navigationReceipt === selectedReceipt ? detailResult : null;
  const detailBusy = Boolean(selected && !currentDetail);
  const detailError = currentDetail?.error;
  const detail = detailError ? null : currentDetail?.detail ?? (navigation ? null : data?.items.find(item => item.id === selected));
  const openDetail = (id: string) => {
    setDetailResult(null);
    setSelectedReceipt(undefined);
    setSelected(id);
  };
  const drawer = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (selected) drawer.current?.showModal();
    else drawer.current?.close();
  }, [selected]);
  useEffect(() => {
    if (!navigation || selected !== navigation.notificationId || selectedReceipt !== navigation.receipt) return;
    if (detailError) {navigation.failed(Error('NAVIGATION_TARGET_UNAVAILABLE'));return;}
    if (!currentDetail?.detail || !drawer.current?.open) return;
    if (currentDetail.detail.interactionRequestId !== navigation.interactionRequestId) {navigation.failed(Error('NAVIGATION_TARGET_UNAVAILABLE'));return;}
    navigation.visible();
  },[navigation,currentDetail,detailError,selected,selectedReceipt]);
  const badge = (value: string | null) => (
    <span className={`gea-inbox-status ${value === "unread" ? "is-unread" : ""}`}>
      {stateLabel(value, t)}
    </span>
  );
  return (
    <section className="gea-inbox" aria-label={t("messageInbox")}>
      {selectedIds.size > 0 && <div className="gea-inbox-selection-actions"><button disabled={busy || mutationBusy || retryPending} onClick={() => {
          const items = data?.items.filter(item => selectedIds.has(item.id) && item.state === "unread" && item.version !== null).map(item => ({ notificationId: item.id, expectedVersion: item.version }));
          if (items?.length && items.length === selectedIds.size) void mutate({ operation: "batch-read", idempotencyKey: crypto.randomUUID(), items });
        }}>{t("markSelectedRead")}</button></div>}
      <div className="gea-inbox-toolbar">
        <label className="gea-inbox-filter">
          {t("inboxStatusLabel")}
          <select disabled={mutationBusy} aria-label={t("notificationState")} value={state} onChange={(event) => {
            setData(null);
            setState(event.target.value);
            setPageNo(1);
          }}>
            <option value="">{t("inboxAll")}</option>
            <option value="unread">{t("notificationUnread")}</option>
            <option value="read">{t("notificationRead")}</option>
            <option value="dismissed">{t("notificationDismissed")}</option>
          </select>
        </label>

      </div>
      <div className="gea-inbox-content">
        {error && <p role="alert">{t(error)}</p>}
        {!selected && mutationNotice}
          <div className="gea-inbox-table-scroll">
            <table>
              <thead><tr>
                <th className="gea-inbox-select-col"><span className="visually-hidden">{t("select")}</span></th><th>{t("inboxBusinessType")}</th><th>{t("inboxSubject")}</th>
                <th>{t("inboxContent")}</th><th>{t("notificationNotifiedAt")}</th>
                <th>{t("inboxStatus")}</th>
              </tr></thead>
              <tbody>{data?.items.map((item) => (
                <tr key={item.id} className={item.state === "unread" ? "is-unread" : ""} onClick={() => openDetail(item.id)}>
                  <td className="gea-inbox-select-col"><input type="checkbox" disabled={busy || mutationBusy || retryPending || item.state !== "unread" || item.version === null} aria-label={`${t("select")} ${item.title ?? item.id}`} checked={selectedIds.has(item.id)} onChange={(event) => { event.stopPropagation(); setSelectedIds((current) => { const next = new Set(current); event.target.checked ? next.add(item.id) : next.delete(item.id); return next; }); }} onClick={(event) => event.stopPropagation()} /></td>
                  <td><span className="gea-inbox-kind">{businessTypeText(item, t)}</span></td>
                  <td><button className="gea-inbox-subject" onClick={() => openDetail(item.id)}>{item.title ?? item.id}</button></td>
                  <td><span className="gea-inbox-summary">{(item.summary?.trim() || item.body?.trim() || t("notificationNoContent")).slice(0, 160)}</span></td>
                  <td className="gea-inbox-date">{formatDate(item.notifiedAt ?? item.createdAt)}</td>
                  <td>{badge(item.state)}</td>
                </tr>
              ))}
              {!data && busy && <tr className="gea-inbox-loading-row"><td colSpan={6}>
                <p role="status">{t("busy")}</p>
                <div className="gea-inbox-placeholder" aria-hidden="true" />
              </td></tr>}
              </tbody>
            </table>
          </div>
          {data && <>
          {data.items.length === 0 && <p className="gea-inbox-empty">{t("empty")}</p>}
          <footer className="gea-inbox-pagination">
            <span>{t("total")}: {data.total} · {t("page")}: {pageNo}</span>
            <div><button disabled={busy || pageNo === 1} onClick={() => { setData(null); setPageNo(pageNo - 1); }}>{t("previous")}</button>
            <button disabled={busy || pageNo * data.pageSize >= data.total} onClick={() => { setData(null); setPageNo(pageNo + 1); }}>{t("next")}</button></div>
          </footer>
        </>}
      </div>
      <dialog ref={drawer} className="gea-inbox-drawer" aria-labelledby="gea-inbox-detail-title"
        onCancel={() => setSelected(null)} onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
        <div className="gea-inbox-drawer-layout">
          <header className="gea-inbox-drawer-header"><h2 id="gea-inbox-detail-title">{t("notificationDetail")}</h2>
            <button aria-label={t("close")} onClick={() => setSelected(null)} autoFocus>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </header>
          <div className="gea-inbox-drawer-body">
            {mutationNotice}
            <div className="gea-inbox-detail-loading" role="status">{detailBusy ? t("busy") : null}</div>
            {detailError && <div role="alert"><p>{t(detailError)}</p><button onClick={() => { setDetailResult(null); setDetailRevision(value => value + 1); }}>{t("refreshInbox")}</button></div>}
            {detail && <article aria-busy={detailBusy}>

              <dl className="gea-inbox-info">
                <div><dt>{t("notificationSource")}</dt><dd>{sourceText(detail, t)}</dd></div>
                <div><dt>{t("notificationCreatedAt")}</dt><dd>{formatDate(detail.createdAt)}</dd></div>
                <div><dt>{t("inboxCurrentStatus")}</dt><dd>{badge(detail.state)}</dd></div>

              </dl>
              <span className="gea-inbox-label">{t("inboxMessageSubject")}</span>
              <h3>{detail.title ?? detail.id}</h3>
              <span className="gea-inbox-label">{t("notificationContent")}</span>
              {detail.actionText && <div className="gea-inbox-action"><span>{detail.actionText}</span>{targetText(detail, t) && <small>{targetText(detail, t)}</small>}</div>}
              <p className="gea-inbox-body">{detail.content?.trim() ? detail.content : detail.body?.trim() ? detail.body : detail.summary?.trim() ? detail.summary : t("notificationNoContent")}</p>
              <fieldset disabled={mutationBusy || retryPending || detailBusy} className="gea-inbox-detail-actions">
                {detail.state === "unread" && detail.version !== null && <button disabled={mutationBusy} onClick={() => mutate({ operation: "read", id: detail.id, expectedVersion: detail.version, idempotencyKey: `read-${detail.id}-${detail.version}` })}>{t("markRead")}</button>}
                {detail.dismissible === true && detail.state !== "dismissed" && detail.version !== null && <button disabled={mutationBusy} onClick={() => mutate({ operation: "dismiss", id: detail.id, expectedVersion: detail.version, idempotencyKey: `dismiss-${detail.id}-${detail.version}` })}>{t("dismissNotification")}</button>}
                {detail.approval?.actionable === true && detail.approval.version !== null && detail.approval.actions.includes("APPROVE") && <button disabled={mutationBusy} onClick={() => mutate({ operation: "approval-action", id: detail.id, action: "APPROVE", expectedVersion: detail.approval?.version, idempotencyKey: `approve-${detail.id}-${detail.approval?.version}` })}>{t("approveNotification")}</button>}
                {detail.approval?.actionable === true && detail.approval.version !== null && detail.approval.actions.includes("REJECT") && <button disabled={mutationBusy} onClick={() => mutate({ operation: "approval-action", id: detail.id, action: "REJECT", expectedVersion: detail.approval?.version, idempotencyKey: `reject-${detail.id}-${detail.approval?.version}` })}>{t("rejectNotification")}</button>}
              </fieldset>
            </article>}
          </div>
          <footer className="gea-inbox-drawer-footer"><button aria-label={t("backToInbox")} onClick={() => setSelected(null)}>{t("close")}</button></footer>
        </div>
      </dialog>
    </section>
  );
}

/**
 * 上游把业务类型、通知类型、来源都按内部编码下发，业务不需要看到编码本身。
 * 这里只登记可读名称；没登记的编码一律降级成通用说法，服务端给的可读文案才原样展示。
 */
const businessTypeLabels: Readonly<Record<string, CopyKey>> = {
  sales_forecast: "inboxBusinessTypeSalesPlan",
  sales_plan: "inboxBusinessTypeSalesPlan",
};
const notificationKindLabels: Readonly<Record<string, CopyKey>> = {
  approval: "inboxNotificationKindApproval",
};
const notificationSourceLabels: Readonly<Record<string, CopyKey>> = {
  "sales_plan.approval_required": "inboxSourceSalesPlanApproval",
  "sales_plan.approval": "inboxSourceSalesPlanApproval",
};
/** 上游 target 里的技术跳转类型（例如 AGENT）对业务没有意义，直接省略。 */
const technicalTargetTypes = new Set(["agent", "system", "service", "user", "internal"]);

function readableText(
  value: string | null | undefined,
  labels: readonly Readonly<Record<string, CopyKey>>[],
  fallback: CopyKey,
  t: Translate,
): string {
  const raw = value?.trim() ?? "";
  if (!raw) return t("unknown");
  const mapped = labels.map((table) => table[raw.toLowerCase()]).find(Boolean);
  if (mapped) return t(mapped);
  return /^[a-z0-9][a-z0-9._:-]*$/.test(raw) ? t(fallback) : raw;
}

function businessTypeText(item: NotificationItem, t: Translate): string {
  return readableText(
    item.businessType ?? item.kind,
    [businessTypeLabels, notificationKindLabels],
    "inboxBusinessTypeFallback",
    t,
  );
}

function sourceText(item: NotificationItem, t: Translate): string {
  return readableText(
    item.source?.label ?? item.source?.type,
    [notificationSourceLabels],
    "inboxSourceFallback",
    t,
  );
}

/** 待办去向只保留业务能看懂的部分；全是技术字段时整段不显示。 */
function targetText(item: NotificationItem, t: Translate): string {
  const target = item.target;
  if (!target) return "";
  const type = target.type?.trim() ?? "";
  return [
    technicalTargetTypes.has(type.toLowerCase()) ? "" : type,
    target.value
      ? readableText(
          target.value,
          [businessTypeLabels, notificationKindLabels],
          "inboxBusinessTypeFallback",
          t,
        )
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function stateLabel(state: string | null, t: Translate): string {
  switch (state) {
    case "unread":
      return t("notificationUnread");
    case "read":
      return t("notificationRead");
    case "dismissed":
      return t("notificationDismissed");
    default:
      return state ?? t("unknown");
  }
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 待办列表/详情共用的一次读取；主页面「预警事件」抽屉也复用同一入口。 */
export async function readNotifications<T = { value: unknown }>(query: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/gea-proof/notifications", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query), signal,
  });
  if (!response.ok) throw new Error("GEA_HTTP_" + response.status);
  const result = await response.json();
  if (!result.ok) throw new Error(result.error.code);
  return result;
}

function notificationError(reason: unknown): CopyKey {
  const code = reason instanceof Error ? reason.message : "";
  if (code === "NOTIFICATION_STATE_CONFLICT" || code === "APPROVAL_VERSION_CONFLICT") return "notificationConflict";
  return ["LOGIN_REQUIRED", "GEA_HTTP_401", "NOTIFICATION_UNAUTHENTICATED"].includes(code)
    ? "loginExpired"
    : ["GEA_HTTP_403", "NOTIFICATION_TENANT_FORBIDDEN"].includes(code)
      ? "forbidden"
      : code === "GEA_REQUEST_TIMEOUT"
        ? "requestTimeout"
        : code === "GEA_NETWORK_ERROR" ? "networkError" : "retry";
}
