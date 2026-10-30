import { createHash } from "node:crypto";
import { orderReportStore } from "./order-report-store.ts";
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
  if (input.operation === "save-edits") {
    if (
      !input.report ||
      Object.keys(input.report).some((k) => k !== "edits") ||
      !input.report.edits ||
      typeof input.report.edits !== "object" ||
      Array.isArray(input.report.edits)
    )
      throw Error("ORDER_REPORT_SAVE_INVALID");
    return orderReportStore(
      {
        ...input,
        operation: "save",
        report: {
          schemaVersion: 1,
          facts: { complete: true, kind: "editor-content" },
          edits: input.report.edits,
        },
      },
      editIdentity,
      execute,
    );
  }
  const result = await orderReportStore(input, identity, execute);
  if (input.operation !== "load") return result;
  if (!("report" in result)) throw Error("ORDER_REPORT_FORMAT_INVALID");
  const edited = await orderReportStore(input, editIdentity, execute);
  if (!("report" in edited)) throw Error("ORDER_REPORT_FORMAT_INVALID");
  if (edited.report && edited.report.facts?.kind !== "editor-content")
    throw Error("ORDER_REPORT_FORMAT_INVALID");
  return {
    ...result,
    editVersion: edited.version,
    report: edited.report
      ? { ...(result.report ?? { schemaVersion: 1, facts: null }), edits: edited.report.edits }
      : result.report,
  };
}
