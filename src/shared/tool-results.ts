/** Normalize tool receipts across retained 0.1 messages and 0.2 tool-role messages. */
export function toolResults(
  message: unknown,
): Array<{ callId: string; isError: boolean; text: string }> {
  if (
    !message ||
    typeof message !== "object" ||
    !("content" in message) ||
    !Array.isArray(message.content)
  )
    return [];
  const text = (content: unknown[]): string =>
    content
      .flatMap((part) =>
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join("");
  if (
    "role" in message &&
    message.role === "tool" &&
    "toolCallId" in message &&
    typeof message.toolCallId === "string"
  ) {
    return [
      {
        callId: message.toolCallId,
        isError: "isError" in message && message.isError === true,
        text: text(message.content),
      },
    ];
  }
  return message.content.flatMap((block) => {
    if (
      !block ||
      typeof block !== "object" ||
      block.type !== "tool-result" ||
      typeof block.toolCallId !== "string" ||
      !Array.isArray(block.content)
    )
      return [];
    return [
      {
        callId: block.toolCallId,
        isError: block.isError === true,
        text: text(block.content),
      },
    ];
  });
}
