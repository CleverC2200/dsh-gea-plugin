import {
  Api,
  Clear,
  Close,
  Copy,
  Delete,
  Refresh,
  ReplayMusic,
  Search,
  Sync,
} from "@icon-park/react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ApiCatalogEntry,
  ApiLogRecord,
  ApiLogSnapshot,
} from "../host/api-log.ts";

type Rpc = <T>(
  endpoint: string,
  payload?: object,
  signal?: AbortSignal,
) => Promise<T>;

type Props = {
  environment: "production" | "test";
  onClose(): void;
  request: Rpc;
};

type OutcomeFilter = "all" | "error";

const methodClass = (method: string) =>
  method === "GET" ? "is-get" : method === "POST" ? "is-post" : "";

const displayTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));

const pretty = (value: unknown) =>
  value == null
    ? "无"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

const replayLabel = (entry: ApiCatalogEntry | ApiLogRecord) => {
  if ("replayAvailable" in entry && !entry.replayAvailable) {
    if (entry.replayPolicy === "blocked") return "禁止重发";
    return "当前不可重发";
  }
  if (entry.replayPolicy === "safe") return "可直接重发";
  if (entry.replayPolicy === "idempotent") return "确认后幂等重发";
  return "禁止重发";
};

const replayNote = (
  record: ApiLogRecord,
  catalog: ApiCatalogEntry | undefined,
) => {
  if (record.replayAvailable)
    return catalog?.replayNote ?? "该请求可在当前身份内重发";
  if (record.replayPolicy === "blocked")
    return catalog?.replayNote ?? "该调用未登记，不能重发";
  return "当前身份、环境或原请求条件已失效，不能重发";
};

function Outcome({ record }: { record: ApiLogRecord }) {
  const label =
    record.outcome === "pending"
      ? "进行中"
      : record.outcome === "success"
        ? "成功"
        : "失败";
  return (
    <span className={`gea-api-outcome is-${record.outcome}`}>{label}</span>
  );
}

function CodeBlock({
  title,
  value,
  onCopy,
}: {
  title: string;
  value: unknown;
  onCopy(value: unknown): void;
}) {
  return (
    <section className="gea-api-code-section">
      <div className="gea-api-code-heading">
        <h3>{title}</h3>
        <button
          type="button"
          onClick={() => onCopy(value)}
          title={`复制${title}`}
        >
          <Copy size={15} />
          复制
        </button>
      </div>
      <pre tabIndex={0}>{pretty(value)}</pre>
    </section>
  );
}

export function ApiLogCenter({ environment, onClose, request }: Props) {
  const [snapshot, setSnapshot] = useState<ApiLogSnapshot>();
  const [selectedCatalog, setSelectedCatalog] = useState<string>("all");
  const [selectedRecord, setSelectedRecord] = useState<string>();
  const [search, setSearch] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyReplay, setBusyReplay] = useState("");
  const [confirmReplay, setConfirmReplay] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState("");
  const refreshing = useRef(false);
  const centerRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => {
    centerRef.current?.focus();
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal, silent = false) => {
      if (refreshing.current) return;
      refreshing.current = true;
      if (!silent) setLoading(true);
      try {
        const next = await request<ApiLogSnapshot>(
          "api-log/snapshot",
          {},
          signal,
        );
        setSnapshot(next);
        setError("");
        setSelectedRecord((current) =>
          current && next.records.some((record) => record.id === current)
            ? current
            : next.records[0]?.id,
        );
      } catch (cause) {
        if (!signal?.aborted)
          setError(cause instanceof Error ? cause.message : "接口日志加载失败");
      } finally {
        refreshing.current = false;
        if (!silent) setLoading(false);
      }
    },
    [request],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = live
      ? window.setInterval(() => void refresh(controller.signal, true), 1500)
      : undefined;
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [live, refresh]);

  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const record of snapshot?.records ?? [])
      if (record.catalogId)
        result.set(record.catalogId, (result.get(record.catalogId) ?? 0) + 1);
    return result;
  }, [snapshot]);

  const groups = useMemo(() => {
    const result = new Map<string, ApiCatalogEntry[]>();
    for (const entry of snapshot?.catalog ?? []) {
      const values = result.get(entry.group) ?? [];
      values.push(entry);
      result.set(entry.group, values);
    }
    return [...result];
  }, [snapshot]);

  const filteredRecords = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return (snapshot?.records ?? []).filter((record) => {
      if (selectedCatalog !== "all" && record.catalogId !== selectedCatalog)
        return false;
      if (outcomeFilter === "error" && record.outcome !== "error") return false;
      if (!keyword) return true;
      return [
        record.catalogName,
        record.group,
        record.request.method,
        record.request.url,
        record.response?.status,
        record.error?.message,
      ]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [outcomeFilter, search, selectedCatalog, snapshot]);

  const activeRecord =
    filteredRecords.find((record) => record.id === selectedRecord) ??
    filteredRecords[0];
  const activeCatalog = snapshot?.catalog.find(
    (entry) => entry.id === activeRecord?.catalogId,
  );
  const selectedCatalogEntry = snapshot?.catalog.find(
    (entry) => entry.id === selectedCatalog,
  );

  const copy = useCallback(async (value: unknown) => {
    try {
      await navigator.clipboard.writeText(pretty(value));
      setCopied("已复制");
      window.setTimeout(() => setCopied(""), 1200);
    } catch {
      setCopied("复制失败");
    }
  }, []);

  const replay = useCallback(
    async (record: ApiLogRecord) => {
      setBusyReplay(record.id);
      setError("");
      try {
        const result = await request<{ recordId: string }>("api-log/replay", {
          id: record.id,
          confirmed: record.replayPolicy === "idempotent",
        });
        setConfirmReplay("");
        await refresh(undefined, true);
        setSelectedRecord(result.recordId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "重发失败");
      } finally {
        setBusyReplay("");
      }
    },
    [refresh, request],
  );

  const clear = useCallback(async () => {
    setLoading(true);
    try {
      const next = await request<ApiLogSnapshot>("api-log/clear", {});
      setSnapshot(next);
      setSelectedRecord(undefined);
      setConfirmClear(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "清空失败");
    } finally {
      setLoading(false);
    }
  }, [request]);

  const selectRecord = useCallback((id: string) => {
    setSelectedRecord(id);
    if (!window.matchMedia("(max-width: 680px)").matches) return;
    window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      detailRef.current?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
      detailRef.current?.focus({ preventScroll: true });
    });
  }, []);

  return (
    <main ref={centerRef} className="gea-api-log-center" tabIndex={-1}>
      <header className="gea-api-log-header">
        <div className="gea-api-log-title">
          <span className="gea-api-log-mark" aria-hidden="true">
            <Api size={21} />
          </span>
          <div>
            <h1>接口日志中心</h1>
            <p>
              {environment === "production" ? "生产环境" : "测试环境"} · Host
              真实上游调用 · 最多保留 {snapshot?.limit ?? 500} 条
            </p>
          </div>
        </div>
        <div className="gea-api-log-actions">
          <div className="gea-api-search">
            <label>
              <Search size={16} />
              <span className="sr-only">搜索调用记录</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索接口、地址、状态"
              />
            </label>
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                title="清空搜索"
                aria-label="清空搜索"
              >
                <Clear size={14} />
              </button>
            )}
          </div>
          <button
            type="button"
            className={live ? "is-active" : ""}
            aria-pressed={live}
            onClick={() => setLive((value) => !value)}
            title={live ? "暂停实时刷新" : "开启实时刷新"}
          >
            <Sync size={16} spin={live && loading} />
            {live ? "实时" : "已暂停"}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <Refresh size={16} spin={loading} />
            刷新
          </button>
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={!snapshot?.records.length}
          >
            <Delete size={16} />
            清空
          </button>
          <button type="button" className="gea-api-close" onClick={onClose}>
            <Close size={17} />
            返回工作台
          </button>
        </div>
      </header>

      {confirmClear && (
        <div className="gea-api-inline-confirm" role="alert">
          <span>只清空当前进程内的脱敏记录，不影响接口目录和业务数据。</span>
          <button type="button" onClick={() => void clear()}>
            确认清空
          </button>
          <button type="button" onClick={() => setConfirmClear(false)}>
            取消
          </button>
        </div>
      )}
      {error && (
        <div className="gea-api-error" role="alert">
          {error}
        </div>
      )}

      <div className="gea-api-layout">
        <nav className="gea-api-catalog" aria-label="接口目录">
          <div className="gea-api-pane-heading">
            <div>
              <h2>接口目录</h2>
              <span>{snapshot?.catalog.length ?? 0} 个已登记接口</span>
            </div>
          </div>
          <button
            type="button"
            className={`gea-api-catalog-item${selectedCatalog === "all" ? " is-selected" : ""}`}
            onClick={() => setSelectedCatalog("all")}
            aria-pressed={selectedCatalog === "all"}
          >
            <span className="gea-api-method">ALL</span>
            <span>全部调用</span>
            <strong>{snapshot?.records.length ?? 0}</strong>
          </button>
          <div className="gea-api-catalog-scroll">
            {groups.map(([group, entries]) => (
              <section key={group}>
                <h3>{group}</h3>
                {entries.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={`gea-api-catalog-item${selectedCatalog === entry.id ? " is-selected" : ""}`}
                    onClick={() => setSelectedCatalog(entry.id)}
                    aria-pressed={selectedCatalog === entry.id}
                    title={`${entry.description} ${entry.replayNote}`}
                  >
                    <span
                      className={`gea-api-method ${methodClass(entry.method)}`}
                    >
                      {entry.method}
                    </span>
                    <span>{entry.name}</span>
                    <strong>{counts.get(entry.id) ?? 0}</strong>
                  </button>
                ))}
              </section>
            ))}
          </div>
        </nav>

        <section className="gea-api-call-list" aria-label="调用记录">
          <div className="gea-api-pane-heading">
            <div>
              <h2>调用记录</h2>
              <span>{filteredRecords.length} 条匹配记录</span>
            </div>
            <div className="gea-api-filter-tabs" aria-label="状态筛选">
              <button
                type="button"
                className={outcomeFilter === "all" ? "is-active" : ""}
                onClick={() => setOutcomeFilter("all")}
                aria-pressed={outcomeFilter === "all"}
              >
                全部
              </button>
              <button
                type="button"
                className={outcomeFilter === "error" ? "is-active" : ""}
                onClick={() => setOutcomeFilter("error")}
                aria-pressed={outcomeFilter === "error"}
              >
                失败
              </button>
            </div>
          </div>
          <div className="gea-api-call-scroll">
            {loading && !snapshot ? (
              <div className="gea-api-empty" role="status">
                正在加载接口调用…
              </div>
            ) : filteredRecords.length ? (
              filteredRecords.map((record) => (
                <button
                  type="button"
                  key={record.id}
                  className={`gea-api-call-row${activeRecord?.id === record.id ? " is-selected" : ""}`}
                  onClick={() => selectRecord(record.id)}
                  aria-pressed={activeRecord?.id === record.id}
                >
                  <span className="gea-api-call-time">
                    {displayTime(record.startedAt)}
                  </span>
                  <span
                    className={`gea-api-method ${methodClass(record.request.method)}`}
                  >
                    {record.request.method}
                  </span>
                  <span className="gea-api-call-main">
                    <strong>{record.catalogName}</strong>
                    <small>{record.request.path}</small>
                  </span>
                  {record.replayedFrom && (
                    <span className="gea-api-replayed">重发</span>
                  )}
                  <span className="gea-api-call-duration">
                    {record.durationMs == null
                      ? "—"
                      : `${record.durationMs} ms`}
                  </span>
                  <Outcome record={record} />
                </button>
              ))
            ) : (
              <div className="gea-api-empty">
                <Api size={34} />
                <strong>
                  {snapshot?.records.length
                    ? "没有匹配的调用"
                    : "还没有接口调用"}
                </strong>
                <span>
                  {snapshot?.records.length
                    ? "调整接口或搜索条件"
                    : "使用工作台后，这里会自动出现真实上游记录"}
                </span>
              </div>
            )}
          </div>
        </section>

        <aside
          ref={detailRef}
          className="gea-api-detail"
          aria-label="调用详情"
          tabIndex={-1}
        >
          {activeRecord ? (
            <>
              <div className="gea-api-detail-heading">
                <div>
                  <span className="gea-api-detail-group">
                    {activeRecord.group}
                  </span>
                  <h2>{activeRecord.catalogName}</h2>
                  <code>{activeRecord.request.path}</code>
                </div>
                <Outcome record={activeRecord} />
              </div>
              <dl className="gea-api-facts">
                <div>
                  <dt>方法</dt>
                  <dd>{activeRecord.request.method}</dd>
                </div>
                <div>
                  <dt>响应</dt>
                  <dd>{activeRecord.response?.status ?? "—"}</dd>
                </div>
                <div>
                  <dt>耗时</dt>
                  <dd>
                    {activeRecord.durationMs == null
                      ? "—"
                      : `${activeRecord.durationMs} ms`}
                  </dd>
                </div>
                <div>
                  <dt>时间</dt>
                  <dd>
                    {new Date(activeRecord.startedAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </dd>
                </div>
                <div>
                  <dt>记录环境</dt>
                  <dd>{activeRecord.environment === "production" ? "生产环境" : "测试环境"}</dd>
                </div>
                {activeRecord.request.headers["x-request-id"] && (
                  <div>
                    <dt>请求 ID</dt>
                    <dd>{activeRecord.request.headers["x-request-id"]}</dd>
                  </div>
                )}
                {activeRecord.request.headers["idempotency-key"] && (
                  <div>
                    <dt>幂等键</dt>
                    <dd>{activeRecord.request.headers["idempotency-key"]}</dd>
                  </div>
                )}
              </dl>
              {activeCatalog && (
                <details className="gea-api-contract">
                  <summary>查看接口定义与请求字段</summary>
                  <p>{activeCatalog.description}</p>
                  {activeCatalog.requestFields.length ? (
                    <div className="gea-api-field-list">
                      {activeCatalog.requestFields.map((field) => (
                        <code key={field}>{field}</code>
                      ))}
                    </div>
                  ) : (
                    <p>无业务请求字段</p>
                  )}
                </details>
              )}
              <section className="gea-api-replay-panel">
                <div>
                  <strong>{replayLabel(activeRecord)}</strong>
                  <span>
                    {replayNote(activeRecord, activeCatalog)}
                  </span>
                </div>
                {activeRecord.replayAvailable &&
                  activeRecord.replayPolicy === "safe" && (
                    <button
                      type="button"
                      onClick={() => void replay(activeRecord)}
                      disabled={busyReplay === activeRecord.id}
                    >
                      <ReplayMusic size={16} />
                      {busyReplay === activeRecord.id ? "正在重发" : "重发请求"}
                    </button>
                  )}
                {activeRecord.replayAvailable &&
                  activeRecord.replayPolicy === "idempotent" &&
                  confirmReplay !== activeRecord.id && (
                    <button
                      type="button"
                      className="is-caution"
                      onClick={() => setConfirmReplay(activeRecord.id)}
                    >
                      <ReplayMusic size={16} />
                      准备幂等重发
                    </button>
                  )}
              </section>
              {confirmReplay === activeRecord.id && (
                <div className="gea-api-write-confirm" role="alert">
                  <strong>确认重发这次写请求？</strong>
                  <span>
                    系统会复用原请求体、请求 ID 和幂等键，不会创建新的操作意图。
                  </span>
                  <div>
                    <button
                      type="button"
                      onClick={() => void replay(activeRecord)}
                      disabled={busyReplay === activeRecord.id}
                    >
                      {busyReplay === activeRecord.id
                        ? "正在重发"
                        : "确认按原幂等键重发"}
                    </button>
                    <button type="button" onClick={() => setConfirmReplay("")}>
                      取消
                    </button>
                  </div>
                </div>
              )}
              {activeRecord.replayedFrom && (
                <p className="gea-api-origin">
                  由记录 {activeRecord.replayedFrom.slice(0, 8)}… 重发产生
                </p>
              )}
              <CodeBlock
                title="请求地址"
                value={activeRecord.request.url}
                onCopy={copy}
              />
              <CodeBlock
                title="请求头"
                value={activeRecord.request.headers}
                onCopy={copy}
              />
              <CodeBlock
                title="请求正文"
                value={activeRecord.request.body}
                onCopy={copy}
              />
              <CodeBlock
                title="响应头"
                value={activeRecord.response?.headers ?? null}
                onCopy={copy}
              />
              <CodeBlock
                title="响应正文"
                value={
                  activeRecord.response?.body ?? activeRecord.error ?? null
                }
                onCopy={copy}
              />
            </>
          ) : selectedCatalogEntry ? (
            <>
              <div className="gea-api-detail-heading">
                <div>
                  <span className="gea-api-detail-group">
                    {selectedCatalogEntry.group}
                  </span>
                  <h2>{selectedCatalogEntry.name}</h2>
                  <code>{selectedCatalogEntry.path}</code>
                </div>
                <span
                  className={`gea-api-method ${methodClass(selectedCatalogEntry.method)}`}
                >
                  {selectedCatalogEntry.method}
                </span>
              </div>
              <section className="gea-api-definition">
                <h3>接口说明</h3>
                <p>{selectedCatalogEntry.description}</p>
              </section>
              <section className="gea-api-definition">
                <h3>请求字段</h3>
                {selectedCatalogEntry.requestFields.length ? (
                  <div className="gea-api-field-list">
                    {selectedCatalogEntry.requestFields.map((field) => (
                      <code key={field}>{field}</code>
                    ))}
                  </div>
                ) : (
                  <p>无业务请求字段</p>
                )}
              </section>
              <section className="gea-api-definition">
                <h3>{replayLabel(selectedCatalogEntry)}</h3>
                <p>{selectedCatalogEntry.replayNote}</p>
              </section>
              <div className="gea-api-empty is-compact">
                <Api size={30} />
                <strong>当前筛选下还没有调用</strong>
                <span>使用对应业务能力后，这里会出现真实请求和响应</span>
              </div>
            </>
          ) : (
            <div className="gea-api-empty">
              <Api size={34} />
              <strong>选择接口或调用记录</strong>
              <span>这里会显示接口定义、脱敏请求、响应和重发规则</span>
            </div>
          )}
        </aside>
      </div>
      <div className="gea-api-copy-status" aria-live="polite">
        {copied}
      </div>
    </main>
  );
}
