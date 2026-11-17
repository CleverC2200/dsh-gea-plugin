import type {} from "../shared/message-source.ts";

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";

export const TURN_ANCHOR_PLUGIN = "gea-plugin";
const TURN_ANCHOR_SUMMARY = "宿主：本轮用户提问（长轮次防丢）";

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

export function turnAnchorText(question: string): string {
  const text = question.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_CHARS);
  return `【本轮用户问题】${text}\n宿主位置、目录和工具结果不是新问题；先交付已核实结果并说明缺口。`;
}

export function isTurnAnchor(message: unknown): boolean {
  const source = (message as AnyMessage | undefined)?.source;
  return (
    source?.kind === "gea-turn-anchor" ||
    (source?.kind === "plugin" && source.plugin === TURN_ANCHOR_PLUGIN)
  );
}

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

export function mountTurnAnchor(
  ctx: Context,
  hooks: {
    onNewQuestion?: (question: string, scope: string) => void;
  } = {},
): () => void {
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
      const turnCount = userTurnCount(current);
      if (lastTurnCount.get(scope) !== turnCount) {
        lastTurnCount.set(scope, turnCount);
        hooks.onNewQuestion?.(question, scope);
      }
    }
    const nextMessages = anchorMessages(current, question, (text) =>
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

    console.log(`[turn-anchor] 已钉住本轮用户提问 chars=${question?.length ?? 0}`);
    return { ...decision, messages: [...nextMessages] };
  });
}
