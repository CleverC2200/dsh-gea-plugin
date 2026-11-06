import { createHash } from "node:crypto";
import { orderReportStore } from "./order-report-store.ts";
import { orderReportImport } from "./order-report-import.ts";
/** Edits retain the exact parent's tenant and base references, in the existing report table. */
export async function orderReportWithEdits(
  input: any,
  identity: Parameters<typeof orderReportStore>[1],
  execute: Parameters<typeof orderReportStore>[2],
) {
  const editIdentity = {
    ...identity,
    reportScope: {
      ...identity.reportScope,
      key:
        "order:edits:" + createHash("sha256").update(identity.reportScope.key).digest("base64url"),
    },
  };
  if (["preview-import", "commit-import"].includes(input.operation))
    return orderReportImport(input, identity, editIdentity, execute);
  if (input.operation === "save-edits") {
    if (
      !input.report ||
      Object.keys(input.report).some((k) => k !== "edits") ||
      !input.report.edits ||
      typeof input.report.edits !== "object" ||
      Array.isArray(input.report.edits)
    )
      throw Error("ORDER_REPORT_SAVE_INVALID");
    const existing = await orderReportStore(
      { operation: "load", period: input.period },
      editIdentity,
      execute,
    );
    if (
      !("report" in existing) ||
      (existing.version !== input.expectedVersion &&
        (!("requestId" in existing) || existing.requestId !== input.requestId))
    )
      throw Error("ORDER_REPORT_VERSION_CONFLICT");
    const { imports: _untrustedImports, ...manual } = input.report.edits;
    const edits = existing.report?.edits?.imports
      ? { ...manual, imports: existing.report.edits.imports }
      : manual;
    return orderReportStore(
      {
        ...input,
        operation: "save",
        report: {
          schemaVersion: 1,
          facts: { complete: true, kind: "editor-content" },
          edits,
        },
      },
      editIdentity,
      execute,
    );
  }
  if (input.operation !== "load") return orderReportStore(input, identity, execute);
  const { includeFacts, ...load } = input;
  if (includeFacts !== undefined && typeof includeFacts !== "boolean")
    throw Error("ORDER_REPORT_REQUEST_INVALID");
  // Fresh governed facts do not need the legacy snapshot's large multipart body.
  // An independent edits record remains authoritative; without it, read legacy
  // content in full so pre-migration manual edits are never dropped.
  const loadFresh = async () => {
    const edited = await orderReportStore(load, editIdentity, execute);
    if (!("report" in edited)) throw Error("ORDER_REPORT_FORMAT_INVALID");
    const result = await orderReportStore(load, identity, execute, { headerOnly: !!edited.report });
    return [result, edited] as const;
  };
  const [result, edited] =
    includeFacts === false
      ? await loadFresh()
      : await Promise.all([
          orderReportStore(load, identity, execute),
          orderReportStore(load, editIdentity, execute),
        ]);
  if (!("report" in result)) throw Error("ORDER_REPORT_FORMAT_INVALID");
  if (!("report" in edited)) throw Error("ORDER_REPORT_FORMAT_INVALID");
  if (edited.report && edited.report.facts?.kind !== "editor-content")
    throw Error("ORDER_REPORT_FORMAT_INVALID");
  return {
    ...result,
    editVersion: edited.version,
    report: edited.report
      ? {
          ...(result.report ?? { schemaVersion: 1, facts: null }),
          edits: edited.report.edits,
        }
      : result.report,
  };
}
