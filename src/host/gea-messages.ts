import { LlmError, type ContentBlock, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { toolResults } from "../shared/tool-results.ts";

type GeaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

function textContent(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function toGeaMessages(options: GenerateOptions): GeaMessage[] {
  const messages: GeaMessage[] = [];
  if (options.system !== undefined) messages.push({ role: "system", content: options.system });
  for (const message of options.messages) {
    if (message.role === "system") {
      const content = textContent(message.content);
      if (content) messages.push({ role: "system", content });
      continue;
    }
    const results = toolResults(message);
    if (results.length) {
      messages.push(
        ...results.map((result) => ({
          role: "tool" as const,
          tool_call_id: result.callId,
          content: result.text || "(no output)",
        })),
      );
      continue;
    }
    if (message.role === "assistant") {
      const reasoning = message.content
        .filter((block) => block.type === "reasoning")
        .map((block) => block.text)
        .join("");
      if (reasoning) {
        // Core keeps cancelled prefixes for display. Only our successful finish
        // supplies this durable replay marker; a partial prefix must not be replayed.
        const replay = message.source?.replayState;
        const response =
          replay && typeof replay === "object" && "response" in replay
            ? replay.response
            : undefined;
        if (
          !response ||
          typeof response !== "object" ||
          !("protocol" in response) ||
          response.protocol !== "gea-client-reasoning-v1" ||
          !("complete" in response) ||
          response.complete !== true
        )
          throw new LlmError(
            "GEA_REASONING_HISTORY_INCOMPLETE: 已保存的思考缺少完整响应标记，请保留原会话并新建会话；不会将部分思考冒充完整历史回传。",
            "PROVIDER_PROTOCOL",
          );
      }
      const calls = message.content
        .filter(
          (block): block is Extract<ContentBlock, { type: "tool-call" }> =>
            block.type === "tool-call",
        )
        .map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        }));
      messages.push({
        role: "assistant",
        content: textContent(message.content) || undefined,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    messages.push({ role: "user", content: textContent(message.content) });
  }
  return messages;
}
