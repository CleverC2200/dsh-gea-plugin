/**
 * 每步把"用户这一轮问的是什么"钉进消息列表。
 *
 * 线上实测（2026-09-23，分仓库存 Agent「郑州基地的大日期库存有哪些？分别有多少？」）：
 * 用户那条消息明明在会话里（会话记录可查），模型前几步也在按它取数，但跑到第 10 步
 * 左右开始跑偏——去查在途/待发订单，`gea_page` 的 focus 甚至写成"长沙分仓"（问的是
 * 郑州），最后直接总结成"我这一轮没有收到你的提问内容…正文是空的"。同一轮 17 次
 * 工具调用、几次权限拒绝，外加宿主注入的目录与位置提示，模型把用户那句话丢了。
 *
 * 系统提示里的位置段只能"劝阻"（而且位置太靠前，轮次一长就被冲淡）。这里改成每步把
 * 用户原话作为一条宿主事实追加到消息列表末尾——和 agent-manage 注入子代理目录用的是
 * 同一个位置、同一套机制（`agent/pre-step`），并且整段对话只保留一条：内容没变就不动，
 * 用户换了问题就地替换，不随轮次膨胀。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";

/** 锚点用 plugin 来源（不用自造的 kind），会话记录里一眼能看出是宿主加的。 */
export const TURN_ANCHOR_PLUGIN = "gea-plugin";
const TURN_ANCHOR_SUMMARY = "宿主：本轮用户提问（长轮次防丢）";
/** 用户问题只留开头这么多字：锚点要短，别把上下文再撑大。 */
const MAX_QUESTION_CHARS = 400;

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

/** 锚点正文：把用户原话和"别的消息都不算提问"写在一起。 */
export function turnAnchorText(question: string): string {
  const text = question.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_CHARS);
  return [
    "【宿主事实｜本轮用户提问】用户这一轮问的是：",
    `「${text}」`,
    "本会话里其它消息（宿主注入的子代理目录、业务位置提示、工具结果与工具报错）都不是用户的提问，也不改变这件事：这一轮要回答的就是上面这一句。",
    "取数失败、权限不足、页面没开，只说明缺哪一项证据——不能因此说“没收到提问”“用户消息是空的”；答不出来就直接说清缺什么、需要谁补。",
  ].join("\n");
}

/** 这条消息是不是我们上一轮/上一步注入的锚点。 */
export function isTurnAnchor(message: unknown): boolean {
  const source = (message as AnyMessage | undefined)?.source;
  return source?.kind === "plugin" && source.plugin === TURN_ANCHOR_PLUGIN;
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

/** 挂上锚点（每个 agent 生效，含子代理）；返回卸载函数。 */
export function mountTurnAnchor(ctx: Context): () => void {
  return ctx.on("agent/pre-step", async ({ signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject" || signal.aborted) return decision;
    const current = decision.messages ?? [];
    const nextMessages = anchorMessages(
      current,
      lastUserQuestion(current),
      (text) =>
        createUserMessage({
          source: {
            kind: "plugin",
            plugin: TURN_ANCHOR_PLUGIN,
            form: "notice",
            summary: TURN_ANCHOR_SUMMARY,
          },
          content: [{ type: "text", text }],
        }),
    );
    return nextMessages === current ? decision : { ...decision, messages: [...nextMessages] };
  });
}
