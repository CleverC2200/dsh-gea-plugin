import { createHash } from "node:crypto";
import { orderReportStore } from "./order-report-store.ts";

type Identity = Parameters<typeof orderReportStore>[1];
type Execute = Parameters<typeof orderReportStore>[2];
const fail = (code: string): never => {
  throw Error(code);
};
const object = (value: any, keys: string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    fail("ORDER_IMPORT_FIELDS_INVALID");
  return value;
};
const text = (value: unknown, max = 1600) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /<\/?[a-z][^>]*>|https?:\/\/|file:\/\//i.test(value)
  )
    fail("ORDER_IMPORT_TEXT_INVALID");
  return (value as string).trim();
};
const digest = (value: unknown, encoding: "hex" | "base64url" = "hex") =>
  createHash("sha256").update(JSON.stringify(value)).digest(encoding);

/** Import content is a separate namespace; no imported row can replace manual edits or KPI facts. */
export function normalizeOrderImport(input: any, period: any, scope: Identity["reportScope"]) {
  const value = object(input, [
    "schemaVersion",
    "batchId",
    "period",
    "source",
    "summary",
    "unmet",
    "short",
    "long",
  ]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.batchId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,80}$/.test(value.batchId)
  )
    fail("ORDER_IMPORT_BATCH_INVALID");
  object(period, ["type", "start", "end"]);
  object(value.period, ["type", "start", "end"]);
  if (
    JSON.stringify([value.period.type, value.period.start, value.period.end]) !==
    JSON.stringify([period.type, period.start, period.end])
  )
    fail("ORDER_IMPORT_PERIOD_MISMATCH");
  const source = object(value.source, ["kind", "name", "sha256"]);
  if (!["file", "message", "example"].includes(source.kind)) fail("ORDER_IMPORT_SOURCE_INVALID");
  const normalizedSource = {
    kind: source.kind,
    name: text(source.name, 200),
    ...(source.kind === "file"
      ? {
          sha256: /^[a-f0-9]{64}$/.test(source.sha256)
            ? source.sha256
            : fail("ORDER_IMPORT_SOURCE_HASH_REQUIRED"),
        }
      : {}),
  };
  const bases = scope.base ? [scope.base] : (scope.bases ?? []);
  if (!Array.isArray(bases) || !bases.length) fail("ORDER_IMPORT_SCOPE_UNAVAILABLE");
  const normalizeRows = (name: string, fields: string[]) => {
    const rows = value[name] ?? [];
    if (!Array.isArray(rows) || rows.length > 50) fail("ORDER_IMPORT_LIMIT_EXCEEDED");
    const keys = new Set();
    return rows.map((candidate: any) => {
      const row = object(candidate, ["key", "base", "source", ...fields]);
      const key = text(row.key, 80),
        base = text(row.base, 50);
      if (keys.has(key)) fail("ORDER_IMPORT_DUPLICATE_KEY");
      keys.add(key);
      if (!bases.includes(base)) fail("ORDER_IMPORT_SCOPE_DENIED");
      const reference = object(row.source, ["sheet", "row"]);
      if (!Number.isSafeInteger(reference.row) || reference.row < 1)
        fail("ORDER_IMPORT_SOURCE_ROW_REQUIRED");
      const normalized: Record<string, any> = {
        key,
        base,
        source: { sheet: text(reference.sheet, 100), row: reference.row },
      };
      for (const field of fields)
        normalized[field] = text(
          row[field],
          ["entity", "dimension", "status"].includes(field) ? 120 : 1600,
        );
      if (
        name === "unmet" &&
        (!["base", "item", "director"].includes(normalized.dimension) ||
          (normalized.dimension === "base" && base === "濮阳") ||
          (normalized.dimension === "base" && normalized.entity !== base))
      )
        fail("ORDER_IMPORT_TARGET_INVALID");
      return normalized;
    });
  };
  const summary =
    value.summary === undefined ? {} : object(value.summary, ["positive", "risk", "rhythm"]);
  const result = {
    schemaVersion: 1,
    batchId: value.batchId,
    period: { type: period.type, start: period.start, end: period.end },
    source: normalizedSource,
    summary: Object.fromEntries(Object.entries(summary).map(([key, val]) => [key, text(val)])),
    unmet: normalizeRows("unmet", ["dimension", "entity", "reason", "measure"]),
    short: normalizeRows("short", ["direction", "measure", "issue"]),
    long: normalizeRows("long", ["mechanism", "content", "goal", "status"]),
  };
  if (
    result.unmet.length + result.short.length + result.long.length > 50 ||
    Buffer.byteLength(JSON.stringify(result)) > 60_000
  )
    fail("ORDER_IMPORT_LIMIT_EXCEEDED");
  if (
    !Object.keys(result.summary).length &&
    !result.unmet.length &&
    !result.short.length &&
    !result.long.length
  )
    fail("ORDER_IMPORT_EMPTY");
  return result;
}

export async function orderReportImport(
  input: any,
  identity: Identity,
  editIdentity: Identity,
  execute: Execute,
) {
  object(input, ["operation", "period", "batch", "expectedVersion", "previewId", "requestId"]);
  const batch = normalizeOrderImport(input.batch, input.period, identity.reportScope);
  const loaded = await orderReportStore(
    { operation: "load", period: input.period },
    editIdentity,
    execute,
  );
  if (!("report" in loaded)) throw Error("ORDER_REPORT_FORMAT_INVALID");
  let edits = loaded.report?.edits;
  if (!edits) {
    const legacy = await orderReportStore(
      { operation: "load", period: input.period },
      identity,
      execute,
    );
    edits = "report" in legacy ? (legacy.report?.edits ?? {}) : {};
  }
  const history = edits.imports ?? [];
  if (!Array.isArray(history) || history.length > 100) fail("ORDER_IMPORT_HISTORY_INVALID");
  const batchHash = digest(batch);
  const previous = history.findLast((entry: any) => entry.batch.batchId === batch.batchId);
  const unchanged = previous?.hash === batchHash;
  const previewId = digest(
    [identity.tenantId, identity.reportScope.key, batch, loaded.version],
    "base64url",
  );
  const counts = {
    summary: Object.keys(batch.summary).length,
    unmet: batch.unmet.length,
    short: batch.short.length,
    long: batch.long.length,
  };
  if (input.operation === "preview-import")
    return {
      previewId,
      editVersion: loaded.version,
      batch,
      counts,
      unchanged,
      canCommit: batch.source.kind !== "example",
      scope: identity.reportScope,
    };
  if (input.operation !== "commit-import" || batch.source.kind === "example")
    fail("ORDER_IMPORT_NOT_PUBLISHABLE");
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(input.requestId)) fail("ORDER_IMPORT_REQUEST_INVALID");
  if ("requestId" in loaded && loaded.requestId === input.requestId) {
    if (previous?.hash !== batchHash || previous?.requestId !== input.requestId)
      fail("ORDER_IMPORT_REQUEST_REUSED");
    return {
      saved: true,
      unchanged: true,
      requestId: input.requestId,
      version: loaded.version,
      edits,
      counts,
    };
  }
  if (input.expectedVersion !== loaded.version || input.previewId !== previewId)
    fail("ORDER_IMPORT_PREVIEW_STALE");
  if (unchanged)
    return {
      saved: true,
      unchanged: true,
      requestId: input.requestId,
      version: loaded.version,
      edits,
      counts,
    };
  if (history.length === 100) fail("ORDER_IMPORT_HISTORY_FULL");
  edits = {
    ...edits,
    imports: [
      ...history,
      {
        batch,
        hash: batchHash,
        requestId: input.requestId,
        actor: identity.id,
        importedAt: new Date().toISOString(),
      },
    ],
  };
  const saved = await orderReportStore(
    {
      operation: "save",
      period: input.period,
      expectedVersion: loaded.version,
      requestId: input.requestId,
      report: { schemaVersion: 1, facts: { complete: true, kind: "editor-content" }, edits },
    },
    editIdentity,
    execute,
  );
  return { ...saved, edits, counts };
}
