/**
 * 页面桥的浏览器侧运行时：轮询 AG-UI 工具调用事件，交给业务实现执行，
 * 再把结果按 AG-UI 的 tool 消息回填给宿主。
 *
 * 与业务无关：业务方只提供 apply(args) —— "怎么把这条调用落到页面上"。
 * 请求函数由业务注入（复用页面自己的 rpc，含登录/401 处理）。
 */
import {
  AGUI_EVENT_TOOL_CALL_ARGS,
  AGUI_EVENT_TOOL_CALL_END,
  AGUI_EVENT_TOOL_CALL_START,
  PAGE_BRIDGE_LIMITS,
  type AgUiEvent,
  type AgUiToolMessage,
} from "./protocol.ts";

export type PageBridgeApplyResult = { applied: boolean; error?: string };

export type PageBridgeApply = (
  args: unknown,
  meta: { toolCallId: string; toolCallName: string },
  signal: AbortSignal,
) => PageBridgeApplyResult | Promise<PageBridgeApplyResult>;

export type PageBridgeClientOptions = {
  /** 宿主侧路由，例如 "agui/workbench"。 */
  endpoint: string;
  /** 页面自己的请求函数：与宿主通信的方式由业务决定。 */
  request: <T>(endpoint: string, payload: object) => Promise<T>;
  /** 当前会话；为空时桥不工作。 */
  sessionId: string | null;
  /** 业务实现：把一次工具调用落到页面上。 */
  apply: PageBridgeApply;
  /** 轮询间隔，默认 1200ms。 */
  pollMs?: number;
  /** 首次轮询前的延迟，默认 500ms。 */
  initialDelayMs?: number;
  /** 单次应用的最长等待；超时按失败回填，避免结果永远悬着。 */
  applyTimeoutMs?: number;
  /** 桥自身出错时的回调（默认忽略，下一轮自动重试）。 */
  onError?: (error: unknown) => void;
  /**
   * 关掉桥时是否要告诉宿主"这个会话已经没有页面能力"（默认是）。
   * 页面被卸载时用它把元素目录撤掉，避免模型继续对着上一屏的元素下指令。
   */
  closeOnDispose?: boolean;
  /**
   * 页面主动发布目录。
   */
  pageSource?: "self-report" | (() => "self-report");
  /**
   * 页面自述的能力目录：这一屏此刻能做什么。
   * 桥据此为这个会话生成工具；不声明（返回 null）就等于没有可调用动作。
   */
  catalog?: () => unknown;
};

/**
 * 启动页面桥客户端，返回 dispose。
 * 桥不可用不能影响业务页面本身：所有错误都吞掉并在下一轮重试。
 */
export function startPageBridgeClient(
  options: PageBridgeClientOptions,
): () => void {
  const pollMs = options.pollMs ?? 1200;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const applyTimeoutMs = options.applyTimeoutMs ?? 8000;
  const buffers = new Map<string, string>();
  const names = new Map<string, string>();
  const settled = new Set<string>();
  const activeApplies = new Map<string, AbortController>();
  const outbox: AgUiToolMessage[] = [];
  let counter = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const closeOnDispose = options.closeOnDispose ?? true;

  const message = (
    toolCallId: string,
    result: PageBridgeApplyResult,
  ): AgUiToolMessage => ({
    id: `page-bridge-result-${++counter}`,
    role: "tool",
    toolCallId,
    content: JSON.stringify({ toolCallId, applied: result.applied }),
    ...(result.error ? { error: result.error } : {}),
  });

  const runApply = async (
    toolCallId: string,
    toolCallName: string,
    args: unknown,
  ): Promise<PageBridgeApplyResult> => {
    const controller = new AbortController();
    activeApplies.set(toolCallId, controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      return await Promise.race([
        Promise.resolve(
          options.apply(
            args,
            { toolCallId, toolCallName },
            controller.signal,
          ),
        ),
        new Promise<PageBridgeApplyResult>((resolve) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              if (!timedOut) resolve({ applied: false, error: "APPLY_CANCELLED" });
            },
            { once: true },
          );
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
            resolve({ applied: false, error: "APPLY_TIMEOUT" });
          }, applyTimeoutMs);
        }),
      ]);
    } catch (error) {
      return { applied: false, error: "APPLY_FAILED" };
    } finally {
      if (timeout) clearTimeout(timeout);
      activeApplies.delete(toolCallId);
    }
  };

  const poll = async (): Promise<void> => {
    const pending = outbox.splice(0, outbox.length);
    try {
      const pageSource =
        typeof options.pageSource === "function"
          ? options.pageSource()
          : options.pageSource;
      const result = await options.request<{ events: AgUiEvent[] }>(
        options.endpoint,
        {
          sessionId: options.sessionId,
          toolMessages: pending,
          ...(options.catalog ? { catalog: options.catalog() } : {}),
          ...(pageSource === undefined ? {} : { pageSource }),
        },
      );
      if (stopped) return;
      for (const event of result.events ?? []) {
        if (event.type === AGUI_EVENT_TOOL_CALL_START) {
          buffers.set(event.toolCallId, "");
          names.set(event.toolCallId, event.toolCallName);
          continue;
        }
        if (event.type === AGUI_EVENT_TOOL_CALL_ARGS) {
          buffers.set(
            event.toolCallId,
            (buffers.get(event.toolCallId) ?? "") + event.delta,
          );
          continue;
        }
        if (event.type !== AGUI_EVENT_TOOL_CALL_END) continue;
        const raw = buffers.get(event.toolCallId) ?? "";
        const toolCallName = names.get(event.toolCallId) ?? "";
        buffers.delete(event.toolCallId);
        names.delete(event.toolCallId);
        if (settled.has(event.toolCallId)) continue;
        settled.add(event.toolCallId);
        let args: unknown;
        try {
          args = JSON.parse(raw);
        } catch {
          outbox.push(message(event.toolCallId, { applied: false, error: "INVALID_TOOL_ARGUMENTS" }));
          continue;
        }
        const outcome = await runApply(
          event.toolCallId,
          toolCallName,
          args,
        );
        if (stopped) return;
        outbox.push(message(event.toolCallId, outcome));
      }
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) timer = setTimeout(() => void poll(), pollMs);
  };

  timer = setTimeout(() => void poll(), initialDelayMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
    for (const controller of activeApplies.values()) controller.abort();
    activeApplies.clear();
    // 最后一件事：把"这个会话没有页面能力"报给宿主。宿主据此立刻注销页面工具，
    // 不必等声明过期。失败就算了：页面已经走了，桥不该影响业务页面本身。
    if (!closeOnDispose || typeof options.sessionId !== "string") return;
    try {
      void Promise.resolve(
        options.request(options.endpoint, {
          sessionId: options.sessionId,
          toolMessages: [],
          catalog: null,
        }),
      ).catch(() => {});
    } catch {
      // 同步抛出的实现同样忽略。
    }
  };
}
