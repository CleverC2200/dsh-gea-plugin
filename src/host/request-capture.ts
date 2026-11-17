import type { HttpAttempt } from "./http-attempt.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

export type CaptureIdentity = {
  environment: string;
  userId: string;
  tenantId: string;
  base: string;
};
export type CaptureSession = { sessionId: string; rootSessionId: string; createdAt?: number };
export type RequestType = "MODEL" | "MCP" | "BUSINESS" | "AUXILIARY" | "UNKNOWN";
export type CaptureMissing = { file: string; reason: string };
export type RequestRow = {
  type: "request";
  seq: number;
  timestamp: string;
  sessionId: string;
  requestId: string;
  requestType: RequestType;
  traceId?: string;
  method: string;
  path: string;
  purpose?: string;
  state: "started" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string;
  httpStatus?: number;
  errorCode?: string;
  responseHeaders?: Record<string, string>;
  retryOfRequestId?: string;
  parentRequestId?: string;
  apiLogId?: string;
};
type SessionFiles = {
  identity: CaptureIdentity;
  sessionId: string;
  directory: string;
  pending: Promise<void>;
  seq: number;
  dseq: number;
  dbytes: number;
  writtenDBytes: number;
  writingD: boolean;
  readingD: boolean;
  closedD: boolean;
  blockedD: boolean;
  requests: Set<string>;
  missing: Map<string, Set<string>>;
};
export type CapturedRequest = {
  row: RequestRow;
  identity?: CaptureIdentity;
  sourceSessionId?: string;
  sessions: Set<SessionFiles>;
  secrets: string[];
  receivedBytes: number;
};
type CaptureContext = {
  session?: CaptureSession;
  purpose?: string;
  parentRequestId?: string;
  retryOfRequestId?: string;
  preparations: Set<CapturedRequest>[];
  onRequest?: (request: CapturedRequest) => void;
  retries?: { current: Map<string, string>; previous: Map<string, string> };
};
export type CaptureConfig = { sessionBytes: number; profileBytes: number; retentionMs: number };
const safe = (value: string, max: number) =>
  Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && code !== 127;
    })
    .join("")
    .slice(0, max);
const key = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scope = (identity: CaptureIdentity) => [
  identity.environment,
  identity.userId,
  identity.tenantId,
  identity.base,
];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const lines = (text: string) =>
  text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean);
const errorCode = (error: unknown) => {
  if (error && typeof error === "object") {
    const value = "code" in error ? error.code : "name" in error ? error.name : undefined;
    if (typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value)) return value;
  }
  return "GEA_REQUEST_FAILED";
};

export class GeaRequestCapture {
  private readonly storage = new AsyncLocalStorage<CaptureContext>();
  private readonly preparations = new WeakMap<object, CapturedRequest[]>();
  private readonly responses = new WeakMap<Response, CapturedRequest>();
  private readonly sessions = new Map<string, SessionFiles>();
  private readonly modelBases = new Map<string, string>();
  private readonly startedAt = Date.now();
  private readonly instance = randomUUID();
  private maintenance = Promise.resolve();
  private disposed = false;
  private disposal?: Promise<void>;
  private readonly inflight = new Set<CapturedRequest>();
  session: (id?: string) => CaptureSession | undefined = () => undefined;

  constructor(
    private readonly root: string,
    private readonly identity: () => CaptureIdentity | undefined,
    private readonly base: () => string,
    readonly config: CaptureConfig = {
      sessionBytes: 8 * 1024 * 1024,
      profileBytes: 64 * 1024 * 1024,
      retentionMs: 7 * 86400000,
    },
  ) {}

  private context(): CaptureContext {
    return this.storage.getStore() ?? { session: this.session(), preparations: [] };
  }

  run<T>(sessionId: string | undefined, purpose: string, action: () => T): T {
    const previous = this.context();
    return this.storage.run(
      { ...previous, session: this.session(sessionId) ?? previous.session, purpose },
      action,
    );
  }

  async *iterate<T>(
    sessionId: string | undefined,
    purpose: string,
    source: AsyncGenerator<T>,
  ): AsyncGenerator<T> {
    const context = {
      ...this.context(),
      session: this.session(sessionId) ?? this.context().session,
      purpose,
    };
    try {
      while (true) {
        const next = await this.storage.run(context, () => source.next());
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await this.storage.run(context, () => source.return(undefined));
    }
  }

  retrying<T>(action: (retry: () => void) => T): T {
    const retries = { current: new Map<string, string>(), previous: new Map<string, string>() };
    return this.storage.run({ ...this.context(), retries }, () =>
      action(() => {
        retries.previous = new Map(retries.current);
      }),
    );
  }

  observe<T>(action: () => T, onRequest: (request: CapturedRequest) => void): T {
    return this.storage.run({ ...this.context(), onRequest }, action);
  }

  async prepare<T>(action: () => Promise<T>): Promise<T> {
    const context = this.context();
    const requests = new Set<CapturedRequest>();
    const value = await this.storage.run(
      { ...context, preparations: [...context.preparations, requests] },
      action,
    );
    if (value && typeof value === "object")
      this.preparations.set(value, [
        ...new Set([...(this.preparations.get(value) ?? []), ...requests]),
      ]);
    return value;
  }

  reuse<T>(value: T): T {
    for (const request of value && typeof value === "object"
      ? (this.preparations.get(value) ?? [])
      : []) {
      const context = this.context();
      this.bind(request, context.session);
      for (const preparation of context.preparations) preparation.add(request);
    }
    return value;
  }

  clone<T>(value: T): T {
    const copy = structuredClone(value);
    if (value && typeof value === "object" && copy && typeof copy === "object") {
      const requests = this.preparations.get(value);
      if (requests) this.preparations.set(copy, requests);
    }
    return copy;
  }

  allowModelBase(base: string): void {
    const identity = this.identity();
    if (identity) this.modelBases.set(base.replace(/\/$/, ""), key(scope(identity)));
  }

  begin(
    input: string,
    method: string,
    headers: Headers,
    purpose?: string,
    attempt?: HttpAttempt,
    operation?: string,
  ): CapturedRequest | undefined {
    if (this.disposed) return;
    const identity = this.identity();
    const url = new URL(input);
    if (
      !input.startsWith(this.base() + "/") &&
      ![...this.modelBases].some(
        ([base, owner]) =>
          identity && owner === key(scope(identity)) && input.startsWith(base + "/"),
      )
    )
      return;
    const context = this.context();
    const path = url.pathname;
    const requestType: RequestType = path.endsWith("/chat/completions")
      ? "MODEL"
      : /\/mcp\//.test(path)
        ? "MCP"
        : /\/(?:sys|aidata\/user-agent-credential|airag|ai\/gateway\/(?:agent\/)?session)(?:\/|$)/.test(
              path,
            ) || path.endsWith("/models")
          ? "AUXILIARY"
          : /\/(?:sales-plan|sql|api\/v1|ai\/sql|ai\/gateway\/(?:sql|client-navigation-intents))(?:\/|$)/.test(
                path,
              )
            ? "BUSINESS"
            : "UNKNOWN";
    const operationKey = operation ? method + " " + path + " " + operation : undefined;
    const prior =
      attempt?.retryOfRequestId ??
      (operationKey ? context.retries?.previous.get(operationKey) : undefined) ??
      context.retryOfRequestId;
    const physicalId = randomUUID();
    const businessId =
      method === "POST" && /\/sales-plan\/plans\/(?:resubmit|versions\/[^/]+\/actions)$/.test(path)
        ? headers.get("X-Request-Id")
        : null;
    const id = businessId ?? physicalId;
    if (businessId) headers.set("X-Trace-Id", physicalId);
    if (operationKey) context.retries?.current.set(operationKey, id);
    headers.set("X-Request-Id", id);
    if (requestType === "MODEL" && !headers.has("X-Trace-Id")) headers.set("X-Trace-Id", id);
    const now = new Date().toISOString();
    const request: CapturedRequest = {
      row: {
        type: "request",
        seq: 0,
        timestamp: now,
        sessionId: "",
        requestId: id,
        requestType,
        ...(businessId ? { traceId: physicalId } : {}),
        method,
        path,
        purpose: safe(purpose ?? context.purpose ?? requestType, 1000),
        state: "started",
        startedAt: now,
        ...(context.parentRequestId ? { parentRequestId: context.parentRequestId } : {}),
        ...(prior ? { retryOfRequestId: prior } : {}),
      },
      identity,
      sourceSessionId: context.session?.sessionId,
      sessions: new Set(),
      receivedBytes: 0,
      secrets: [
        headers.get("Authorization"),
        headers.get("X-Access-Token"),
        headers.get("X-Delegation-Token"),
      ]
        .filter((value): value is string => !!value)
        .flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")]),
    };
    if (!/\/ai\/feedback\/reports(?:\/|$)/.test(path)) {
      for (const preparation of context.preparations) preparation.add(request);
      this.bind(request, context.session);
    }
    if (attempt) attempt.requestId = id;
    this.inflight.add(request);
    context.onRequest?.(request);
    return request;
  }

  private files(identity: CaptureIdentity, session: CaptureSession): SessionFiles {
    const owner = key(scope(identity));
    const id = owner + "/" + key(session.rootSessionId);
    const known = this.sessions.get(id);
    if (known) return known;
    const state: SessionFiles = {
      identity: { ...identity },
      sessionId: session.rootSessionId,
      directory: join(this.root, owner, key(session.rootSessionId)),
      pending: Promise.resolve(),
      seq: 0,
      dseq: 0,
      dbytes: 0,
      writtenDBytes: 0,
      writingD: false,
      readingD: false,
      closedD: false,
      blockedD: false,
      requests: new Set(),
      missing: new Map(),
    };
    this.sessions.set(id, state);
    this.enqueue(state, async () => {
      await mkdir(state.directory, { recursive: true, mode: 0o700 });
      const metadata = await this.readObject(join(state.directory, "capture.json"));
      if (metadata) {
        state.closedD ||= metadata.dClosed === true;
        state.blockedD ||= metadata.dClosed === true;
        if (metadata.active === true && metadata.instance !== this.instance)
          this.missing(
            state,
            "gea-requests.jsonl",
            "上次采集进程未正常结束，不能确认中断区间的请求覆盖",
          );
        const reasons = metadata.missing;
        if (record(reasons))
          for (const [file, list] of Object.entries(reasons))
            if (Array.isArray(list))
              for (const reason of list)
                if (typeof reason === "string") this.missing(state, file, reason);
      } else if (session.createdAt === undefined || session.createdAt < this.startedAt) {
        this.missing(state, "gea-requests.jsonl", "会话早于本次请求采集启用时间，历史请求未补造");
      }
      try {
        const previous = await readFile(join(state.directory, "requests.jsonl"), "utf8");
        for (const line of lines(previous)) {
          try {
            const row: unknown = JSON.parse(line);
            if (record(row) && typeof row.seq === "number" && Number.isSafeInteger(row.seq))
              state.seq = Math.max(state.seq, row.seq);
            if (record(row) && typeof row.requestId === "string") state.requests.add(row.requestId);
          } catch {
            this.missing(state, "gea-requests.jsonl", "请求清单存在坏行，保留其他有效记录");
          }
        }
        if (previous && !previous.endsWith("\n")) {
          this.missing(state, "gea-requests.jsonl", "请求清单存在不完整尾行");
          await appendFile(join(state.directory, "requests.jsonl"), "\n");
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
          this.missing(state, "gea-requests.jsonl", "旧请求清单读取失败，不能确认历史覆盖");
      }
      try {
        const previous = await readFile(join(state.directory, "diagnostics.jsonl"), "utf8");
        state.writtenDBytes = Buffer.byteLength(previous);
        state.dbytes += state.writtenDBytes;
        for (const line of lines(previous)) {
          try {
            const row: unknown = JSON.parse(line);
            if (record(row) && typeof row.seq === "number")
              state.dseq = Math.max(state.dseq, row.seq);
          } catch {
            state.closedD = true;
            state.blockedD = true;
            this.missing(state, "gea-diagnostics.jsonl", "历史 D 点存在坏行，停止追加原文");
          }
        }
        if (previous && !previous.endsWith("\n")) {
          state.closedD = true;
          state.blockedD = true;
          this.missing(state, "gea-diagnostics.jsonl", "历史 D 点存在未完成尾行，停止追加原文");
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
          this.missing(state, "gea-diagnostics.jsonl", "D 点文件状态不可读");
      }
      state.closedD ||= state.dbytes >= this.config.sessionBytes;
      await this.writeMetadata(state, true);
    });
    return state;
  }

  private missing(state: SessionFiles, file: string, reason: string): void {
    const reasons = state.missing.get(file) ?? new Set<string>();
    reasons.add(reason);
    state.missing.set(file, reasons);
  }

  private enqueue(
    state: SessionFiles,
    action: () => Promise<void>,
    file = "gea-requests.jsonl",
  ): void {
    if (this.disposed) return;
    state.pending = state.pending.then(action).catch(async () => {
      this.missing(
        state,
        file,
        file === "gea-requests.jsonl"
          ? "请求清单写入失败，覆盖可能不完整"
          : "D 点写入或原文配额检查失败",
      );
      if (file === "gea-diagnostics.jsonl") {
        state.closedD = true;
        state.blockedD = true;
        await this.writeMetadata(state, true).catch(() => {});
      }
    });
  }

  private async readObject(path: string): Promise<Record<string, unknown> | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      return record(value) ? value : undefined;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  private writeMetadata(state: SessionFiles, active: boolean): Promise<void> {
    return writeFileAtomic(
      join(state.directory, "capture.json"),
      JSON.stringify({
        identity: state.identity,
        sessionId: state.sessionId,
        active,
        instance: this.instance,
        dClosed: state.closedD,
        missing: Object.fromEntries(
          [...state.missing].map(([file, reasons]) => [file, [...reasons]]),
        ),
      }) + "\n",
      { mode: 0o600 },
    );
  }

  private bind(request: CapturedRequest, session: CaptureSession | undefined): void {
    if (this.disposed) return;
    const identity = this.identity();
    if (
      !request.identity ||
      !session ||
      !identity ||
      key(scope(request.identity)) !== key(scope(identity))
    )
      return;
    const state = this.files(request.identity, session);
    if (request.sessions.has(state)) return;
    request.sessions.add(state);
    request.sourceSessionId ??= session.sessionId;
    this.append(request, state);
  }

  private append(request: CapturedRequest, state: SessionFiles): void {
    const snapshot = {
      ...request.row,
      sessionId: state.sessionId,
      responseHeaders: request.row.responseHeaders ? { ...request.row.responseHeaders } : undefined,
    };
    this.enqueue(state, async () => {
      state.requests.add(snapshot.requestId);
      await appendFile(
        join(state.directory, "requests.jsonl"),
        JSON.stringify({ ...snapshot, seq: ++state.seq, timestamp: new Date().toISOString() }) +
          "\n",
        { mode: 0o600 },
      );
      await this.writeMetadata(state, true);
    });
  }

  update(request: CapturedRequest): void {
    for (const state of request.sessions) this.append(request, state);
  }

  of(response: Response): CapturedRequest | undefined {
    return this.responses.get(response);
  }

  finish(request: CapturedRequest | undefined, state: RequestRow["state"], code?: string): void {
    if (this.disposed || !request || request.row.state !== "started") return;
    this.inflight.delete(request);
    request.row.state = state;
    request.row.endedAt = new Date().toISOString();
    if (code) request.row.errorCode = safe(code, 100);
    this.update(request);
  }

  fail(request: CapturedRequest | undefined, error: unknown, signal?: AbortSignal | null): void {
    const timeout = signal?.aborted && errorCode(signal.reason).toLowerCase().includes("timeout");
    this.finish(request, signal?.aborted && !timeout ? "cancelled" : "failed", errorCode(error));
  }

  response(response: Response, request: CapturedRequest, signal?: AbortSignal | null): Response {
    request.row.httpStatus = response.status;
    request.row.responseHeaders = Object.fromEntries(
      ["X-Request-Id", "X-Trace-Id"].flatMap((name) => {
        const value = response.headers.get(name);
        return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? [[name, value]] : [];
      }),
    );
    this.update(request);
    if (!response.body) {
      this.responses.set(response, request);
      if (request.row.requestType !== "MODEL") this.finish(request, "completed");
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const next = await reader.read();
            if (next.done) {
              if (request.row.requestType !== "MODEL") this.finish(request, "completed");
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            this.fail(request, error, signal);
            controller.error(error);
          }
        },
        cancel: async (reason) => {
          if (request.row.requestType !== "MODEL")
            this.finish(
              request,
              signal?.aborted ? "cancelled" : "completed",
              signal?.aborted ? errorCode(signal.reason) : undefined,
            );
          await reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    this.responses.set(wrapped, request);
    return wrapped;
  }

  diagnostic(
    request: CapturedRequest | undefined,
    kind: "received" | "assembled" | "terminal",
    payload: unknown,
  ): void {
    if (this.disposed || !request || request.row.requestType !== "MODEL") return;
    if (kind === "received" && typeof payload === "string")
      request.receivedBytes += Buffer.byteLength(payload);
    for (const state of request.sessions) {
      if (state.closedD || this.config.sessionBytes === 0) {
        this.missing(
          state,
          "gea-diagnostics.jsonl",
          "D 点采集关闭、达到容量或写入失败；已收片段可能不完整",
        );
        continue;
      }
      let text = JSON.stringify({
        sessionId: state.sessionId,
        executionSessionId: request.sourceSessionId,
        requestId: request.row.requestId,
        timestamp: new Date().toISOString(),
        seq: ++state.dseq,
        stage: "D",
        kind,
        payload,
      });
      for (const secret of request.secrets)
        if (secret.length >= 8) text = text.split(secret).join("[已脱敏]");
      const bytes = Buffer.byteLength(text + "\n");
      if (state.dbytes + bytes + 1024 > this.config.sessionBytes) {
        state.closedD = true;
        this.missing(
          state,
          "gea-diagnostics.jsonl",
          "D 点达到会话容量上限，保留已收前缀；后续原文未采集",
        );
        const marker =
          JSON.stringify({
            sessionId: state.sessionId,
            requestId: request.row.requestId,
            timestamp: new Date().toISOString(),
            seq: ++state.dseq,
            stage: "D",
            kind: "truncated",
            payload: { receivedBytes: request.receivedBytes, reason: "session capacity" },
          }) + "\n";
        if (state.dbytes + Buffer.byteLength(marker) <= this.config.sessionBytes) {
          state.dbytes += Buffer.byteLength(marker);
          this.enqueue(
            state,
            async () => {
              if (
                state.blockedD ||
                state.writtenDBytes + Buffer.byteLength(marker) > this.config.sessionBytes
              )
                return;
              await this.maintain(state.directory, Buffer.byteLength(marker), () =>
                appendFile(join(state.directory, "diagnostics.jsonl"), marker, { mode: 0o600 }),
              );
              state.writtenDBytes += Buffer.byteLength(marker);
            },
            "gea-diagnostics.jsonl",
          );
        }
        this.enqueue(state, () => this.writeMetadata(state, true), "gea-diagnostics.jsonl");
        continue;
      }
      state.dbytes += bytes;
      this.enqueue(
        state,
        async () => {
          if (state.blockedD) return;
          if (state.writtenDBytes + bytes + 1024 > this.config.sessionBytes) {
            state.closedD = true;
            this.missing(state, "gea-diagnostics.jsonl", "D 点达到会话容量上限，后续原文未采集");
            await this.writeMetadata(state, true);
            return;
          }
          state.writingD = true;
          try {
            await this.maintain(state.directory, bytes, () =>
              appendFile(join(state.directory, "diagnostics.jsonl"), text + "\n", { mode: 0o600 }),
            );
            state.writtenDBytes += bytes;
          } finally {
            state.writingD = false;
          }
        },
        "gea-diagnostics.jsonl",
      );
    }
  }

  private maintain(current: string, incoming: number, write: () => Promise<void>): Promise<void> {
    const run = this.maintenance.then(async () => {
      const entries: { path: string; size: number; mtime: number }[] = [];
      for (const owner of await readdir(this.root, { withFileTypes: true })) {
        if (!owner.isDirectory()) continue;
        for (const session of await readdir(join(this.root, owner.name), { withFileTypes: true })) {
          if (!session.isDirectory()) continue;
          const path = join(this.root, owner.name, session.name, "diagnostics.jsonl");
          try {
            const s = await stat(path);
            entries.push({ path, size: s.size, mtime: s.mtimeMs });
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
        }
      }
      let size = entries.reduce((n, e) => n + e.size, 0);
      for (const entry of entries.sort((a, b) => a.mtime - b.mtime)) {
        if (entry.path === join(current, "diagnostics.jsonl")) continue;
        if (
          Date.now() - entry.mtime < this.config.retentionMs &&
          size + incoming <= this.config.profileBytes
        )
          continue;
        const active = [...this.sessions.values()].some(
          (s) =>
            join(s.directory, "diagnostics.jsonl") === entry.path && (s.writingD || s.readingD),
        );
        if (active) continue;
        const metadataPath = join(dirname(entry.path), "capture.json");
        const metadata = await this.readObject(metadataPath);
        const missing = record(metadata?.missing) ? metadata.missing : {};
        const previous = missing["gea-diagnostics.jsonl"];
        await writeFileAtomic(
          metadataPath,
          JSON.stringify({
            ...metadata,
            dClosed: true,
            missing: {
              ...missing,
              "gea-diagnostics.jsonl": [
                ...(Array.isArray(previous) ? previous : []),
                "D 点原文因保留期限或 profile 容量被淘汰",
              ],
            },
          }) + "\n",
          { mode: 0o600 },
        );
        await unlink(entry.path);
        size -= entry.size;
        for (const state of this.sessions.values())
          if (join(state.directory, "diagnostics.jsonl") === entry.path) {
            state.closedD = true;
            state.blockedD = true;
            this.missing(state, "gea-diagnostics.jsonl", "D 点原文因保留期限或 profile 容量被淘汰");
            this.enqueue(state, () => this.writeMetadata(state, true), "gea-diagnostics.jsonl");
          }
      }
      if (size + incoming > this.config.profileBytes) throw Error("GEA_DIAGNOSTICS_PROFILE_LIMIT");
      await write();
    });
    this.maintenance = run.catch(() => {});
    return run;
  }

  async snapshot(sessionId: string): Promise<{
    files: Record<string, Uint8Array>;
    missing: CaptureMissing[];
    requestIds: Set<string>;
    apiLogIds: Set<string>;
  }> {
    const identity = this.identity();
    if (!identity) throw Error("GEA_FEEDBACK_LOGIN_REQUIRED");
    const session = this.session(sessionId) ?? { sessionId, rootSessionId: sessionId };
    const state = this.files(identity, session);
    const owners = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const owner of owners)
      if (owner.isDirectory() && owner.name !== key(scope(identity))) {
        const previous = await this.readObject(
          join(this.root, owner.name, key(session.rootSessionId), "capture.json"),
        );
        if (previous)
          this.missing(
            state,
            "gea-requests.jsonl",
            "此会话存在其他登录身份的采集材料，本次未归集；仅包含当前登录身份的材料",
          );
      }
    await state.pending;
    const files: Record<string, Uint8Array> = {};
    const requestIds = new Set<string>();
    const apiLogIds = new Set<string>();
    for (const [source, target] of [
      ["requests.jsonl", "gea-requests.jsonl"],
      ["diagnostics.jsonl", "gea-diagnostics.jsonl"],
    ]) {
      try {
        if (
          target === "gea-diagnostics.jsonl" &&
          Date.now() - (await stat(join(state.directory, source))).mtimeMs > this.config.retentionMs
        ) {
          this.missing(state, target, "D 点原文已过保留期限");
          state.closedD = true;
          continue;
        }
        state.readingD = target === "gea-diagnostics.jsonl";
        const raw = await readFile(join(state.directory, source), "utf8");
        state.readingD = false;
        const complete = lines(raw)
          .filter((line) => {
            try {
              const row: unknown = JSON.parse(line);
              if (target !== "gea-requests.jsonl")
                return (
                  record(row) && typeof row.requestId === "string" && requestIds.has(row.requestId)
                );
              const valid =
                record(row) &&
                row.type === "request" &&
                typeof row.requestId === "string" &&
                typeof row.seq === "number";
              if (valid && typeof row.requestId === "string") {
                requestIds.add(row.requestId);
                if (typeof row.apiLogId === "string") apiLogIds.add(row.apiLogId);
              }
              return valid;
            } catch {
              this.missing(state, target, "请求清单坏行已省略，覆盖可能不完整");
              return false;
            }
          })
          .join("\n");
        if (raw && !raw.endsWith("\n"))
          this.missing(state, target, "文件存在未完成尾行，仅导出完整行前缀");
        files[target] = Buffer.from(complete ? complete + "\n" : "");
      } catch {
        state.readingD = false;
        if (
          target === "gea-requests.jsonl" &&
          state.requests.size === 0 &&
          !state.missing.has(target)
        )
          files[target] = Buffer.alloc(0);
        else
          this.missing(
            state,
            target,
            target === "gea-diagnostics.jsonl"
              ? "本次未取得模型 D 点材料"
              : "请求清单读取失败，覆盖无法确认",
          );
      }
    }
    if (!files["gea-diagnostics.jsonl"])
      this.missing(state, "gea-diagnostics.jsonl", "本次未取得模型 D 点材料");
    return {
      files,
      missing: [...state.missing].map(([file, reasons]) => ({
        file,
        reason: [...reasons].join("；").slice(0, 1000),
      })),
      requestIds,
      apiLogIds,
    };
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    for (const request of this.inflight) {
      this.finish(request, "cancelled", "GEA_CAPTURE_DISPOSED");
      this.diagnostic(request, "terminal", {
        state: "cancelled",
        errorCode: "GEA_CAPTURE_DISPOSED",
      });
    }
    this.disposed = true;
    this.disposal = (async () => {
      for (const state of this.sessions.values()) {
        await state.pending;
        await this.writeMetadata(state, false).catch(() => {});
      }
    })();
    return this.disposal;
  }
}
