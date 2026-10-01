import React from "react";
import { projectUserText } from "@deepseek-ai/dsh-client-ui-primitives";
import type { UserTextOwnerProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { projectReferenceText } from "./reference.ts";

/** Pure rendering; copy, edit, queue actions and model input keep the owner's wire text. */
export function PageReferenceText({ text, sessionLabels, slashNames, slashKind, references, maxLength }: UserTextOwnerProps) {
  const projected = projectReferenceText(text);
  return projectUserText(projected.text, sessionLabels, slashNames, slashKind, references, maxLength,
    projected.ranges.map(range => ({
      ...range,
      render: label => <span data-ref-chip="page" style={{ color: "var(--dsw-alias-state-business-primary)", textDecoration: "underline", textUnderlineOffset: "3px" }}>{label}</span>,
    })),
  );
}

export function installReferenceDisplay(ctx: any): void {
  ctx.slots.inject("conversation.user.text", () => ctx.slots.register(
    { name: "conversation.user.text", priority: -10 },
    PageReferenceText,
  ));
}
