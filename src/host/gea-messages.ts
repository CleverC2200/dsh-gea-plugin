import { offloadedImageText, type ContentBlock, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { toolResults } from "../shared/tool-results.ts";

type GeaUserPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ImageRef = Extract<ContentBlock, { type: "image" }>["attachment"];

export type GeaMessage =
  | { role: "user"; content: string | GeaUserPart[] }
  | {
      role: "system" | "assistant" | "tool";
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

export function toGeaMessages(
  options: GenerateOptions,
  images: ReadonlyMap<ImageRef["attachmentId"], string> = new Map(),
): GeaMessage[] {
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
    const parts = message.content.flatMap((block): GeaUserPart[] => {
      if (block.type === "text") return [{ type: "text", text: block.text }];
      if (block.type !== "image") return [];
      if (block.offloaded) return [{ type: "text", text: offloadedImageText(block.attachment) }];
      const url = images.get(block.attachment.attachmentId);
      if (!url) throw Error("GEA_MODEL_IMAGE_NOT_PREPARED");
      return [{ type: "image_url", image_url: { url } }];
    });
    const content = parts.some((part) => part.type === "image_url")
      ? parts
      : parts.map((part) => (part.type === "text" ? part.text : "")).join("");
    messages.push({ role: "user", content });
  }
  return messages;
}
