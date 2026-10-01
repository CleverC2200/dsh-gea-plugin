import React from "react";
import { limitUserText, projectUserText } from "@deepseek-ai/dsh-client-ui-primitives";
import type { UserTextOwnerProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { projectReferenceText } from "./reference.ts";

/** Pure rendering; copy, edit, queue actions and model input keep the owner's wire text. */
export function PageReferenceText({ text, sessionLabels, slashNames, slashKind, references, maxLength }: UserTextOwnerProps) {
  const projected = projectReferenceText(text);
  const visible = limitUserText(projected.text, maxLength);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const plain = (start: number, end: number) => projectUserText(visible.slice(start, end), sessionLabels, slashNames, slashKind, references);
  for (const range of projected.ranges) {
    if (range.start >= visible.length) break;
    if (range.start > cursor) parts.push(<React.Fragment key={`plain-${cursor}`}>{plain(cursor, range.start)}</React.Fragment>);
    const end = Math.min(range.end, visible.length);
    parts.push(<span key={range.start} data-ref-chip="page" style={{ color: "var(--dsw-alias-state-business-primary)", textDecoration: "underline", textUnderlineOffset: "3px" }}>{visible.slice(range.start, end)}</span>);
    cursor = end;
  }
  if (cursor < visible.length || parts.length === 0) parts.push(<React.Fragment key={`plain-${cursor}`}>{plain(cursor, visible.length)}</React.Fragment>);
  return <>{parts}</>;
}

export function installReferenceDisplay(ctx: any): void {
  ctx.slots.inject("conversation.user.text", () => ctx.slots.register(
    { name: "conversation.user.text", priority: -10 },
    PageReferenceText,
  ));
}
