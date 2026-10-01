export const PAGE_INTERACTION = "dsh-page-interaction-v1";
export const REFERENCE_SOURCE = "page-content";

export type PageReference = {
  page: string;
  kind?: "row" | "table" | "block";
  label: string;
  text: string;
  row?: string;
  column?: string;
  scope?: string;
  targets: string[];
  capturedAt: string;
  truncated?: boolean;
};
export type BoundReference = PageReference & {
  sessionId: string;
  surface: string;
  tool?: string;
};

const text = (value: unknown, limit: number) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";

/** Bounds incoming page evidence; never interprets it as an instruction. */
export function pageReference(value: unknown): PageReference | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (typeof v.text !== "string" || !v.text.trim()) return;
  return {
    page: text(v.page, 160),
    kind: v.kind === "row" || v.kind === "table" ? v.kind : "block",
    label: text(v.label, 160) || "页面内容",
    text: text(v.text, 6000),
    row: text(v.row, 200),
    column: text(v.column, 200),
    scope: text(v.scope, 1000),
    targets: Array.isArray(v.targets)
      ? v.targets.filter(
          (x): x is string => typeof x === "string" && x.length <= 200,
        )
      : [],
    capturedAt: text(v.capturedAt, 64),
    truncated: v.text.length > 6000 || v.truncated === true,
  };
}

export type ReferenceReceipt = { id: string; label: string };

export function serializeReference(value: ReferenceReceipt): string {
  if (!/^R[a-f0-9]{12}$/.test(value.id) || typeof value.label !== "string")
    throw Error("引用已失效，请重新选择内容。");
  const label = value.label.replace(/[%\[\]\\@\/\r\n]/g, encodeURIComponent);
  return `[${label}](dsh-page:${value.id}) `;
}

/** Pure display projection of the current receipt form; never used to rewrite model text. */
export function projectReferenceText(text: string): {
  text: string;
  labels: string[];
  ranges: Array<{ start: number; end: number }>;
} {
  const pattern =
    /@?\[([^\]\n]+)\]\(dsh-page:(R[a-f0-9]{12})\)/g;
  const labels: string[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  let display = "",
    cursor = 0;
  for (const match of text.matchAll(pattern)) {
    display += text.slice(cursor, match.index);
    let label = match[1];
    try {
        label = decodeURIComponent(label);
      } catch {
        /* Malformed labels remain readable text; receipt identity is unchanged. */
      }
    const start = display.length;
    display += label;
    ranges.push({ start, end: display.length });
    labels.push(label);
    cursor = match.index! + match[0].length;
  }
  return { text: display + text.slice(cursor), labels, ranges };
}
/** Only explicit user references opt a conversation into the reference prompt/tool. */
export function hasPageReferences(
  events: readonly { type: string; data: unknown }[],
): boolean {
  return events.some(
    (event) =>
      event.type === "user/message" &&
      /dsh-page:R[a-f0-9]{12}/.test(JSON.stringify(event.data)),
  );
}
