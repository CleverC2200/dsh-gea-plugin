/** Read-only GEA inbox. Notification state does not alter DSH interaction or Session state. */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CopyKey } from "./locales.ts";
import type { NotificationItem } from "./notifications.ts";

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

/** Keep list and detail reads independent; discard late responses on navigation. */
export function Inbox({ t }: { t: Translate }) {
  const [pageNo, setPageNo] = useState(1);
  const [state, setState] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [data, setData] = useState<Page | null>(null);
  const [detailResult, setDetailResult] = useState<{
    id: string;
    detail?: NotificationItem;
    error?: CopyKey;
  } | null>(null);
  const [error, setError] = useState<CopyKey | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
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
        if (!controller.signal.aborted) setDetailResult({ id: selected, detail: result.value.detail });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setDetailResult({ id: selected, error: notificationError(reason) });
      });
    return () => controller.abort();
  }, [selected, detailRevision]);
  const currentDetail = detailResult?.id === selected ? detailResult : null;
  const detailBusy = Boolean(selected && !currentDetail);
  const detailError = currentDetail?.error;
  const detail = detailError ? null : currentDetail?.detail ?? data?.items.find(item => item.id === selected);
  const openDetail = (id: string) => {
    setDetailResult(null);
    setSelected(id);
  };
  const drawer = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (selected) drawer.current?.showModal();
    else drawer.current?.close();
  }, [selected]);
  const badge = (value: string | null) => (
    <span className={`gea-inbox-status ${value === "unread" ? "is-unread" : ""}`}>
      {stateLabel(value, t)}
    </span>
  );
  return (
    <section className="gea-inbox" aria-label={t("messageInbox")}>
      <header className="gea-inbox-header">
        <div className="gea-inbox-heading">
          <h1>{t("businessInbox")}</h1>
          {data && <span className="gea-inbox-unread">{data.unreadCount} {t("inboxUnreadMessages")}</span>}
        </div>
        <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>{t("refreshInbox")}</button>
      </header>
      <div className="gea-inbox-toolbar">
        <label className="gea-inbox-filter">
          {t("inboxStatusLabel")}
          <select aria-label={t("notificationState")} value={state} onChange={(event) => {
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
          <div className="gea-inbox-table-scroll">
            <table>
              <thead><tr>
                <th>{t("inboxBusinessType")}</th><th>{t("inboxSubject")}</th>
                <th>{t("inboxContent")}</th><th>{t("notificationCreatedAt")}</th>
                <th>{t("inboxStatus")}</th>
              </tr></thead>
              <tbody>{data?.items.map((item) => (
                <tr key={item.id} className={item.state === "unread" ? "is-unread" : ""} onClick={() => openDetail(item.id)}>
                  <td><span className="gea-inbox-kind">{item.kind ?? t("unknown")}</span></td>
                  <td><button className="gea-inbox-subject" onClick={() => openDetail(item.id)}>{item.title ?? item.id}</button></td>
                  <td><span className="gea-inbox-summary">{(item.summary?.trim() || item.body?.trim() || t("notificationNoContent")).slice(0, 160)}</span></td>
                  <td className="gea-inbox-date">{formatDate(item.createdAt)}</td>
                  <td>{badge(item.state)}</td>
                </tr>
              ))}
              {!data && busy && <tr className="gea-inbox-loading-row"><td colSpan={5}>
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
          <p className="gea-inbox-hint">{t("inboxReadOnly")}</p>
          <details className="gea-inbox-provenance"><summary>{t("inboxQueryInfo")}</summary><p>{t(data.environment)} · {t("returned")}: {data.items.length} · {t(data.coverage)} · {t("fetchedAt")}: {formatDate(data.fetchedAt)}</p></details>
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
            <div className="gea-inbox-detail-loading" role="status">{detailBusy ? t("busy") : null}</div>
            {detailError && <div role="alert"><p>{t(detailError)}</p><button onClick={() => { setDetailResult(null); setDetailRevision(value => value + 1); }}>{t("refreshInbox")}</button></div>}
            {detail && <article aria-busy={detailBusy}>

              <dl className="gea-inbox-info">
                <div><dt>{t("notificationSource")}</dt><dd>{detail.source?.label ?? t("unknown")}</dd></div>
                <div><dt>{t("notificationAggregate")}</dt><dd>{detail.aggregateId ?? t("unknown")}</dd></div>
                <div><dt>{t("notificationCreatedAt")}</dt><dd>{formatDate(detail.createdAt)}</dd></div>
                <div><dt>{t("inboxCurrentStatus")}</dt><dd>{badge(detail.state)}</dd></div>

              </dl>
              <span className="gea-inbox-label">{t("inboxMessageSubject")}</span>
              <h3>{detail.title ?? detail.id}</h3>
              <span className="gea-inbox-label">{t("notificationContent")}</span>
              <p className="gea-inbox-body">{detail.body?.trim() ? detail.body : detail.summary?.trim() ? detail.summary : t("notificationNoContent")}</p>
              <details className="gea-inbox-more"><summary>{t("inboxAdditionalInfo")}</summary><dl className="gea-inbox-info"><div><dt>{t("notificationKind")}</dt><dd>{detail.kind ?? t("unknown")}</dd></div><div><dt>{t("notificationSourceRef")}</dt><dd>{detail.source?.ref ?? t("unknown")}</dd></div><div><dt>{t("notificationExpiry")}</dt><dd>{formatDate(detail.expiresAt)}</dd></div></dl></details>
            </article>}
          </div>
          <footer className="gea-inbox-drawer-footer"><button aria-label={t("backToInbox")} onClick={() => setSelected(null)}>{t("close")}</button></footer>
        </div>
      </dialog>
    </section>
  );
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

async function readNotifications<T>(query: object, signal: AbortSignal): Promise<T> {
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
  return ["LOGIN_REQUIRED", "GEA_HTTP_401", "NOTIFICATION_UNAUTHENTICATED"].includes(code)
    ? "loginExpired"
    : ["GEA_HTTP_403", "NOTIFICATION_TENANT_FORBIDDEN"].includes(code)
      ? "forbidden"
      : code === "GEA_REQUEST_TIMEOUT"
        ? "requestTimeout"
        : code === "GEA_NETWORK_ERROR" ? "networkError" : "retry";
}
