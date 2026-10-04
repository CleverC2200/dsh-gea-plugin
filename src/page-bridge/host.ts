/**
 * 页面桥的宿主侧状态机：把「前端工具调用」排队，等页面取走并把 tool 消息回填。
 *
 * 与业务无关：业务方只说"工具叫什么、参数是什么"，这里不解释参数含义，
 * 也不碰任何业务数据。路由由消费方自己挂（鉴权与路径属于业务/部署决定）。
 */
import { randomUUID } from "node:crypto";
import {
  AGUI_EVENT_TOOL_CALL_ARGS,
  AGUI_EVENT_TOOL_CALL_END,
  AGUI_EVENT_TOOL_CALL_START,
  PAGE_BRIDGE_LIMITS,
  validateToolMessages,
  type AgUiEvent,
  type AgUiToolMessage,
} from "@cleverc2200/dsh-agent-workbench/page-interaction/protocol";

type PendingToolCall = {
  toolCallId: string;
  toolCallName: string;
  args: unknown;
  expiresAt: number;
};

type BridgeSession = {
  toolCalls: PendingToolCall[];
  results: Map<string, { message: AgUiToolMessage; receivedAt: number }>;
  /** 已取消的调用：既阻止排队下发，也丢弃页面迟到的回执。 */
  cancelled: Map<string, number>;
};

export type PageBridgeOptions = {
  /** 命令在页面取走前的最长存活时间。 */
  ttlMs?: number;
  /** 单会话最多挂起多少条调用。 */
  maxQueued?: number;
  /** 便于测试注入时钟。 */
  now?: () => number;
  /** 便于测试注入 id 生成。 */
  id?: () => string;
};

export type PageBridge = {
  enqueue(sessionId: string, input: { toolCallName: string; args: unknown }): string;
  pull(sessionId: string, toolMessages: unknown): AgUiEvent[];
  take(sessionId: string, toolCallId: string): AgUiToolMessage | undefined;
  /** 取消尚未完成的调用；迟到的页面回执不会再进入宿主结果队列。 */
  cancel(sessionId: string, toolCallId: string): void;
  wait(sessionId: string, toolCallId: string, waitMs: number, pollMs?: number, signal?: AbortSignal): Promise<AgUiToolMessage | undefined>;
  reset(sessionId: string): void;
  /** 身份或部署整体变化时清空所有会话。 */
  resetAll(): void;
};

/** 建一个页面桥；每个宿主进程一个实例即可。 */
export function createPageBridge(options: PageBridgeOptions = {}): PageBridge {
  const now = options.now ?? (() => Date.now());
  const nextId = options.id ?? (() => randomUUID());
  const ttlMs = options.ttlMs ?? PAGE_BRIDGE_LIMITS.ttlMs;
  const maxQueued = options.maxQueued ?? PAGE_BRIDGE_LIMITS.maxQueued;
  const sessions = new Map<string, BridgeSession>();

  const sessionOf = (sessionId: string): BridgeSession => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created: BridgeSession = {
      toolCalls: [],
      results: new Map(),
      cancelled: new Map(),
    };
    sessions.set(sessionId, created);
    return created;
  };

  const prune = (session: BridgeSession, at: number): void => {
    session.toolCalls = session.toolCalls.filter((call) => call.expiresAt > at);
    for (const [toolCallId, result] of session.results)
      if (at - result.receivedAt > ttlMs) session.results.delete(toolCallId);
    for (const [toolCallId, cancelledAt] of session.cancelled)
      if (at - cancelledAt > ttlMs) session.cancelled.delete(toolCallId);
  };

  const take = (
    sessionId: string,
    toolCallId: string,
  ): AgUiToolMessage | undefined => {
    const session = sessions.get(sessionId);
    const result = session?.results.get(toolCallId);
    if (!session || !result) return undefined;
    session.results.delete(toolCallId);
    return result.message;
  };

  const cancel = (sessionId: string, toolCallId: string): void => {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.toolCalls = session.toolCalls.filter(
        (call) => call.toolCallId !== toolCallId,
      );
      session.results.delete(toolCallId);
      session.cancelled.set(toolCallId, now());
      prune(session, now());
  };


  return {
    enqueue(sessionId, input) {
      const session = sessionOf(sessionId);
      const toolCallId = nextId();
      session.toolCalls.push({
        toolCallId,
        toolCallName: input.toolCallName,
        args: input.args,
        expiresAt: now() + ttlMs,
      });
      if (session.toolCalls.length > maxQueued)
        session.toolCalls.splice(0, session.toolCalls.length - maxQueued);
      return toolCallId;
    },

    pull(sessionId, toolMessages) {
      const session = sessions.get(sessionId);
      if(!session)return [];
      prune(session,now());
      for (const message of validateToolMessages(toolMessages)) {
        if(!session.toolCalls.some(call=>call.toolCallId===message.toolCallId))continue;
        // 超时取消后，页面可能已经在执行并迟到回传；这条回执不能复活调用。
        if (session.cancelled.has(message.toolCallId)) continue;
        session.results.set(message.toolCallId, {
          message,
          receivedAt: now(),
        });
        session.toolCalls = session.toolCalls.filter(
          (call) => call.toolCallId !== message.toolCallId,
        );
      }
      prune(session, now());
      return session.toolCalls.flatMap((call) => [
        {
          type: AGUI_EVENT_TOOL_CALL_START,
          toolCallId: call.toolCallId,
          toolCallName: call.toolCallName,
        },
        {
          type: AGUI_EVENT_TOOL_CALL_ARGS,
          toolCallId: call.toolCallId,
          delta: JSON.stringify(call.args),
        },
        { type: AGUI_EVENT_TOOL_CALL_END, toolCallId: call.toolCallId },
      ]) as AgUiEvent[];
    },

    take,

    cancel,

    async wait(sessionId, toolCallId, waitMs, pollMs = 100, signal) {
      signal?.throwIfAborted();
      const owner=sessions.get(sessionId);
      if(!owner)return undefined;
      const deadline=now()+waitMs;
      try {
        for(;;){
          signal?.throwIfAborted();
          if(sessions.get(sessionId)!==owner)throw Error("PAGE_TOOL_OWNER_CHANGED");
          const result=take(sessionId,toolCallId);
          if(result)return result;
          if(now()>=deadline){cancel(sessionId,toolCallId);return undefined;}
          await new Promise<void>((resolve,reject)=>{
            const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason);};
            const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},Math.min(pollMs,Math.max(0,deadline-now())));
            signal?.addEventListener('abort',abort,{once:true});
            if(signal?.aborted)abort();
          });
        }
      }catch(error){cancel(sessionId,toolCallId);throw error;}
    },

    reset(sessionId) {
      sessions.delete(sessionId);
    },

    resetAll() {
      sessions.clear();
    },
  };
}
