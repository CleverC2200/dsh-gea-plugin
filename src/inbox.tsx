/** Read-only GEA inbox. Notification state does not alter DSH interaction or Session state. */
import React, { useEffect, useState } from "react";
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

/** Mount a fresh read on each page or detail selection and discard late responses on navigation. */
export function Inbox({ t }: { t: Translate }) {
  const [pageNo, setPageNo] = useState(1);
  const [state, setState] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<Page | null>(null);
  const [detail, setDetail] = useState<NotificationItem | null>(null);
  const [error, setError] = useState<CopyKey | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setDetail(null);
    setError(null);
    setBusy(true);
    void fetch("/api/gea-proof/notifications", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selected ? { id: selected } : { pageNo, state }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("GEA_HTTP_" + response.status);
        const result = await response.json();
        if (!result.ok) throw new Error(result.error.code);
        if (controller.signal.aborted) return;
        if (selected) setDetail(result.value.detail);
        else setData(result.value);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const code = reason instanceof Error ? reason.message : "";
        setError(
          [
            "LOGIN_REQUIRED",
            "GEA_HTTP_401",
            "NOTIFICATION_UNAUTHENTICATED",
          ].includes(code)
            ? "loginExpired"
            : ["GEA_HTTP_403", "NOTIFICATION_TENANT_FORBIDDEN"].includes(code)
              ? "forbidden"
              : code === "GEA_REQUEST_TIMEOUT"
                ? "requestTimeout"
                : code === "GEA_NETWORK_ERROR"
                  ? "networkError"
                  : "retry",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [pageNo, selected, revision, state]);
  return (
    <section className="gea-inbox" aria-label={t("messageInbox")}>
      <h1>{t("messageInbox")}</h1>
      <p>{t("inboxReadOnly")}</p>
      <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>
        {t("refreshInbox")}
      </button>
      {selected ? (
        <button onClick={() => setSelected(null)}>{t("backToInbox")}</button>
      ) : null}
      {!selected ? (
        <label className="gea-inbox-filter">
          {t("notificationState")}
          <select
            aria-label={t("notificationState")}
            value={state}
            onChange={(event) => {
              setState(event.target.value);
              setPageNo(1);
            }}
          >
            <option value="">{t("all")}</option>
            <option value="unread">{t("notificationUnread")}</option>
            <option value="read">{t("notificationRead")}</option>
            <option value="dismissed">{t("notificationDismissed")}</option>
          </select>
        </label>
      ) : null}
      {busy ? <p role="status">{t("busy")}</p> : null}
      {error ? <p role="alert">{t(error)}</p> : null}
      {data && !busy ? (
        <>
          <p>
            {t(data.environment)} · {t("total")}: {data.total} ·{" "}
            {t("unreadCount")}: {data.unreadCount} · {t("fetchedAt")}:{" "}
            {data.fetchedAt}
          </p>
          <p>
            {t("returned")}: {data.items.length} · {t(data.coverage)}
          </p>
          {data.items.length === 0 ? (
            <p>{t("empty")}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("notificationTitle")}</th>
                  <th>{t("notificationState")}</th>
                  <th>{t("notificationKind")}</th>
                  <th>{t("notificationSource")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <button onClick={() => setSelected(item.id)}>
                        {item.title ?? item.id}
                      </button>
                    </td>
                    <td>{stateLabel(item.state, t)}</td>
                    <td>{item.kind ?? t("unknown")}</td>
                    <td>{item.source?.label ?? t("unknown")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p>
            {t("page")}: {pageNo}
          </p>
          <button disabled={pageNo === 1} onClick={() => setPageNo(pageNo - 1)}>
            {t("previous")}
          </button>
          <button
            disabled={pageNo * data.pageSize >= data.total}
            onClick={() => setPageNo(pageNo + 1)}
          >
            {t("next")}
          </button>
        </>
      ) : null}
      {detail && !busy ? (
        <article>
          <h2>{detail.title ?? detail.id}</h2>
          <p>{detail.summary ?? t("unknown")}</p>
          <dl>
            <dt>{t("notificationState")}</dt>
            <dd>{stateLabel(detail.state, t)}</dd>
            <dt>{t("notificationKind")}</dt>
            <dd>{detail.kind ?? t("unknown")}</dd>
            <dt>{t("notificationSource")}</dt>
            <dd>{detail.source?.label ?? t("unknown")}</dd>
            <dt>{t("notificationSourceRef")}</dt>
            <dd>{detail.source?.ref ?? t("unknown")}</dd>
            <dt>{t("notificationAggregate")}</dt>
            <dd>{detail.aggregateId ?? t("unknown")}</dd>
            <dt>{t("notificationExpiry")}</dt>
            <dd>{detail.expiresAt ?? t("unknown")}</dd>
          </dl>
        </article>
      ) : null}
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
