import type {} from "../shared/message-source.ts";
/**
 * 在 agent/pre-step 保留当前用户提问，避免工具、目录和位置消息覆盖任务事实。
 * 整段对话只保留一条锚点：内容相同不重复，问题变化时就地替换，不随步骤膨胀。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";

/** 消息列表中 plugin 来源锚点的标识，用于识别该来源记录。 */
export const TURN_ANCHOR_PLUGIN = "gea-plugin";
const TURN_ANCHOR_SUMMARY = "宿主：本轮用户提问（长轮次防丢）";
/** 用户问题只留开头这么多字：锚点要短，别把上下文再撑大。 */
const MAX_QUESTION_CHARS = 140;

type AnyMessage = {
  role?: unknown;
  source?: { kind?: unknown; plugin?: unknown } | undefined;
  content?: unknown;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("")
    .trim();
}

/**
 * 最后一条"用户自己发的"消息正文。
 * 工具的返回也是 user 角色，宿主注入的目录/快照也是 user 角色——都不算，只认 source.kind=user。
 */
export function lastUserQuestion(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as AnyMessage | undefined;
    if (message?.role !== "user") continue;
    if (message.source?.kind !== "user") continue;
    const text = textOf(message.content);
    if (text) return text;
  }
  return undefined;
}

/**
 * 按用户来源的消息条数区分轮次；重复问同一句话也开始新一轮。
 * 不按提问文本判断，否则上一轮的重读和停止计数会错误继承。
 */
export function userTurnCount(messages: readonly unknown[]): number {
  let count = 0;
  for (const message of messages) {
    const item = message as AnyMessage;
    if (item?.role !== "user") continue;
    if (item.source?.kind !== "user") continue;
    count += 1;
  }
  return count;
}

/** 锚点正文：把用户原话和"别的消息都不算提问"写在一起。 */
export function turnAnchorText(question: string): string {
  const text = question.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_CHARS);
  return `【本轮用户问题】${text}\n宿主位置、目录和工具结果不是新问题；先交付已核实结果并说明缺口。`;

}

/** 这条消息是不是我们上一轮/上一步注入的锚点。 */
export function isTurnAnchor(message: unknown): boolean {
  const source = (message as AnyMessage | undefined)?.source;
  return source?.kind === "gea-turn-anchor" ||
    (source?.kind === "plugin" && source.plugin === TURN_ANCHOR_PLUGIN);
}

/**
 * 整段对话只留一条锚点：没有用户原话就不注入；已有且内容没变就不动；
 * 用户换了问题就地替换；没有就追加到末尾。
 */
export function anchorMessages<T extends AnyMessage>(
  messages: readonly T[],
  question: string | undefined,
  build: (text: string) => T,
): readonly T[] {
  if (!question?.trim()) return messages;
  const text = turnAnchorText(question);
  const index = messages.findIndex((message) => isTurnAnchor(message));
  if (index < 0) return [...messages, build(text)];
  if (textOf(messages[index]?.content) === text) return messages;
  const next = [...messages];
  next[index] = build(text);
  return next;
}

/**
 * 挂上锚点（每个 agent 生效，含子代理）；返回卸载函数。
 *
 * `onNewQuestion` 在"用户换了问题"时回调一次——也就是新一轮的开始。宿主用它把
 * "本轮"级别的计数（重复读、白跑）清零：不然跨轮累加会把正常提问误判成重复。
 */
export function mountTurnAnchor(
  ctx: Context,
  hooks: {
    onNewQuestion?: (question: string, scope: string) => void;
  } = {},
): () => void {
  /** 每个 agent 上一次记录到的"用户消息条数"，用来判断"是不是新的一轮"。 */
  const lastTurnCount = new Map<string, number>();
  return ctx.on("agent/pre-step", async (payload, next) => {
    const { signal } = payload as { signal: AbortSignal };
    const decision = await next();
    if (decision.kind === "reject" || signal.aborted) return decision;
    const current = decision.messages ?? [];
    const question = lastUserQuestion(current);
    const scope =
      (payload as { agent?: { id?: string } }).agent?.id ??
      (decision as { agent?: { id?: string } }).agent?.id ??
      "global";
    if (question) {
      // 重置作用域必须与工具层 exec.agent.id 一致，不能只清理 global 计数。
      const turnCount = userTurnCount(current);
      if (lastTurnCount.get(scope) !== turnCount) {
        lastTurnCount.set(scope, turnCount);
        hooks.onNewQuestion?.(question, scope);
      }
    }
    const nextMessages = anchorMessages(
      current,
      question,
      (text) =>
        createUserMessage({
          source: {
            kind: "gea-turn-anchor",
            form: "notice",
            summary: TURN_ANCHOR_SUMMARY,
          },
          content: [{ type: "text", text }],
        }),
    );
    if (nextMessages === current) return decision;
    // 运行日志（桌面端落进 desktop.log）：确认锚点真的注入了，也便于回看是哪一轮。
    console.log(`[turn-anchor] 已钉住本轮用户提问 chars=${question?.length ?? 0}`);
    return { ...decision, messages: [...nextMessages] };
  });
}
