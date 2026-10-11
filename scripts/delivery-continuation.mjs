import { normalizeReceiptTime as timestamp } from "./delivery-time.mjs";
/** Derived accounting and continuation only; consumes the same bounded bytes as checkDelivery. */
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const parse = (input) => {
  try {
    return JSON.parse(input.bytes);
  } catch {
    return null;
  }
};
const evidence = (input) =>
  input?.sha256
    ? [
        {
          sourceId: input.id,
          sha256: input.sha256,
          observedAt: input.observedAt,
        },
      ]
    : [];
const metrics = {
  SQL: ["SQL", "physicalSQL", "physicalSQLRequests"],
  REST: ["REST", "businessREST"],
  models: ["models", "modelTasks", "businessModelTasks"],
  writes: ["businessWrites", "businessWrite"],
  metadata: ["GEAMetadata", "GEAMetadataRequests"],
  starts: ["NativeStarts"],
};
function metric(data, aliases) {
  const values = aliases.filter((key) => data?.[key] !== undefined).map((key) => data[key]);
  return values.length && values.every(count) && new Set(values).size === 1 ? values[0] : null;
}

export function deriveBudget({ delivery, inputs, observedAt, scoped }) {
  if (delivery?.budget === undefined) return null;
  const declaration = delivery.budget;
  const valid =
    scoped &&
    Array.isArray(declaration?.receipts) &&
    declaration.receipts.length > 0 &&
    declaration.receipts.length <= 100 &&
    declaration.receipts.every((ref) => id(ref?.sourceId) && id(ref.caseId)) &&
    new Set(declaration.receipts.map((ref) => ref.caseId)).size === declaration.receipts.length &&
    new Set(declaration.receipts.map((ref) => ref.sourceId)).size === declaration.receipts.length;
  const records = (valid ? declaration.receipts : []).map((ref) => {
    const matches = inputs.filter((input) => input.id === ref.sourceId),
      input = matches[0],
      data = matches.length === 1 ? parse(input) : null;
    const sourceAt = timestamp(data?.at),
      through = timestamp(data?.terminalSnapshotAt ?? data?.at);
    const matched =
      data?.case === ref.caseId &&
      sourceAt &&
      through &&
      Date.parse(through) <= Date.parse(sourceAt) &&
      Date.parse(sourceAt) <= Date.parse(observedAt);
    const quota = matched
      ? ["maxRequests", "periods", "list", "detail", "versionSkus", "workflowSql", "metadata"]
          .filter((key) => data.readonlyValidation?.limits?.[key] !== undefined)
          .map((key) => {
            const limit = data.readonlyValidation.limits[key],
              spent = data.readonlyValidation.spent?.[key];
            return {
              metric: key,
              limit: count(limit) ? limit : null,
              spent: count(spent) ? spent : null,
              unspentRecorded:
                count(limit) && count(spent) && spent <= limit ? limit - spent : null,
              usableNow: "unknown",
            };
          })
      : [];
    return {
      sourceId: ref.sourceId,
      caseId: ref.caseId,
      relation: matched ? "recorded" : "unavailable",
      observedAt: sourceAt,
      through: matched ? through : null,
      effects: "unknown",
      quota,
      counts: Object.fromEntries(
        Object.entries(metrics).map(([name, aliases]) => [
          name,
          matched ? metric(data, aliases) : null,
        ]),
      ),
      evidence: evidence(input),
    };
  });
  const counts = Object.fromEntries(
    Object.keys(metrics).map((name) => {
      const known = records.map((record) => record.counts[name]).filter((value) => value !== null);
      const total = known.reduce((sum, value) => sum + value, 0);
      return [
        name,
        {
          confirmed: Number.isSafeInteger(total) && known.length ? total : null,
          completeness:
            valid && known.length === records.length && Number.isSafeInteger(total)
              ? "recorded"
              : "unknown",
        },
      ];
    }),
  );
  const available =
    valid &&
    records.every((record) => record.relation === "recorded") &&
    ["SQL", "models", "writes"].every((name) => counts[name].completeness === "recorded");
  const exceeded = records.some((record) =>
    record.quota.some(
      (quota) => quota.limit !== null && quota.spent !== null && quota.spent > quota.limit,
    ),
  );
  const quotaKnown = records.every((record) =>
    record.quota.every((quota) => quota.unspentRecorded !== null),
  );
  const status = exceeded ? "failed" : available && quotaKnown ? "observed" : "unknown";
  return {
    status,
    reason: exceeded
      ? "RECORDED_PHYSICAL_QUOTA_EXCEEDED"
      : status === "observed"
        ? "SCOPED_RECEIPT_COUNTS_ONLY"
        : "SCOPED_RECEIPTS_AND_TIME_REQUIRED",
    minimumGap:
      status === "observed"
        ? null
        : exceeded
          ? "RECONCILE_ORIGINAL_PHYSICAL_QUOTA_WITHOUT_RESET_REQUIRED"
          : "UNIQUE_CASE_RECEIPTS_AT_OR_BEFORE_REPORT_REQUIRED",
    counts,
    records,
    through: available
      ? records
          .map((record) => record.through)
          .sort()
          .at(-1)
      : null,
    afterCutoff: "unknown",
    effectsAfterCutoff: "unknown",
    evidence: records.flatMap((record) => record.evidence),
    observedAt,
    proof: "recorded-physical-counts",
  };
}

export function deriveContinuation({ delivery, task, inputs, observedAt, scoped }) {
  const goal = delivery?.goal;
  const valid =
    scoped &&
    id(goal?.id) &&
    Array.isArray(goal.stages) &&
    goal.stages.length > 0 &&
    new Set(goal.stages).size === goal.stages.length &&
    goal.stages.every((stage) => task.stages.some((result) => result.stage === stage));
  const requested = valid ? task.stages.filter((result) => goal.stages.includes(result.stage)) : [];
  const verified = requested.filter((result) =>
    ["passed", "not-applicable"].includes(result.status),
  );
  const remaining = requested
    .filter((result) => !verified.includes(result))
    .map((result) => {
      const permission = task.authorization?.find((item) => item.stage === result.stage);
      const suggestion = task.suggestions?.find((item) => item.stage === result.stage);
      if (permission?.stopEffects?.includes("pause"))
        return {
          ...result,
          cause: "user-paused",
          minimumGap: "HUMAN_RESUME_FOR_SAME_SCOPE_REQUIRED",
        };
      if (task.consistency.status !== "observed")
        return {
          ...result,
          cause: "source-gap",
          reason: task.consistency.reason,
          minimumGap: task.consistency.minimumGap,
        };
      if (task.dependencies?.status === "blocked" && suggestion?.status !== "can-continue")
        return {
          ...result,
          cause: "dependency-unmet",
          minimumGap: "PREDECESSOR_DONE_OR_EXPLICIT_STAGE_EXCEPTION_REQUIRED",
        };
      if (
        suggestion?.status === "blocked" &&
        ["review-owner", "configuration-owner", "approval-owner", "browser-owner"].includes(
          suggestion.owner,
        )
      )
        return {
          ...result,
          cause: "external-condition",
          reason: suggestion.reason,
          minimumGap: suggestion.minimumGap,
          evidence: suggestion.evidence,
        };
      return { ...result, cause: "unknown" };
    });
  const independentNextActions = remaining.flatMap((result) => {
    const suggestion = task.suggestions?.find(
      (item) => item.stage === result.stage && item.action === "manual-work",
    );
    return suggestion?.status === "can-continue"
      ? [
          {
            stage: result.stage,
            reason: suggestion.reason,
            evidence: suggestion.evidence,
            minimumGap: null,
            action: "manual-work",
          },
        ]
      : [];
  });
  const inTransit =
    task.runtime?.tools.filter(
      (tool) =>
        !["exited", "failed"].includes(tool.command.state) ||
        !["completed", "failed"].includes(tool.turn),
    ) ?? [];
  const terminalEvidenceMissing =
    valid &&
    task.consistency.status === "observed" &&
    !remaining.length &&
    inTransit.length > 0;
  const state = !valid
    ? "unknown"
    : task.consistency.status !== "observed"
      ? "unknown"
      : !remaining.length
        ? terminalEvidenceMissing
          ? "unknown"
          : "completed"
        : independentNextActions.length
          ? "actionable"
          : remaining.some((result) => result.cause === "user-paused")
            ? "user-paused"
            : remaining.some((result) => result.cause === "dependency-unmet")
              ? "dependency-unmet"
              : remaining.every((result) => result.cause === "external-condition")
                ? "external-conditions"
                : "unknown";
  const reasons = {
    completed: "DECLARED_GOAL_STAGES_VERIFIED",
    actionable: "INDEPENDENT_AUTHORIZED_WORK_REMAINS",
    "user-paused": "EXPLICIT_HUMAN_PAUSE",
    "dependency-unmet": "ORIGINAL_PREREQUISITE_UNMET",
    "external-conditions": "ONLY_EXTERNAL_CONDITIONS_REMAIN",
    unknown: "SCOPED_GOAL_AND_READY_ACTION_REQUIRED",
  };
  const candidate = task.candidate
    ? Object.fromEntries(
        ["kind", "commit", "sha256", "contentSha256", "proof"].map((key) => [
          key,
          task.candidate[key],
        ]),
      )
    : null;
  return {
    goal: valid ? { id: goal.id, stages: goal.stages } : null,
    state,
    reason:
      state === "unknown" && terminalEvidenceMissing
        ? "TOOL_TERMINAL_STATES_REQUIRED"
        : reasons[state],
    minimumGap:
      state === "unknown"
        ? (task.consistency.minimumGap ??
          (terminalEvidenceMissing
            ? "CONFIRMED_COMMAND_AND_TURN_TERMINAL_STATES_REQUIRED"
            : "EXPLICIT_GOAL_SCOPE_AND_SCOPED_READINESS_REQUIRED"))
        : null,
    executionStatus: task.executionStatus,
    candidate,
    inputs: inputs
      .filter((input) => input.sha256)
      .map((input) => ({
        sourceId: input.id,
        sha256: input.sha256,
        observedAt: input.observedAt,
      })),
    verified,
    remaining,
    inTransit,
    independentNextActions,
    stopConditions: remaining.map((result) => ({
      stage: result.stage,
      reason: result.reason,
      minimumGap: result.minimumGap,
      evidence: result.evidence,
    })),
    observedAt,
    performsActions: false,
  };
}

export function summarizeContinuation(tasks, observedAt) {
  const groups = Object.fromEntries(
    [
      "actionable",
      "external-conditions",
      "user-paused",
      "dependency-unmet",
      "completed",
      "unknown",
    ].map((state) => [
      state,
      tasks.filter((task) => task.continuation.state === state).map((task) => task.taskId),
    ]),
  );
  const state = groups.actionable.length
    ? "actionable"
    : groups.unknown.length || !tasks.length
      ? "unknown"
      : groups["user-paused"].length
        ? "user-paused"
        : groups["dependency-unmet"].length
          ? "dependency-unmet"
          : groups["external-conditions"].length
            ? "external-conditions"
            : "completed";
  return {
    state,
    groups,
    independentNextActions: tasks.flatMap((task) =>
      task.continuation.independentNextActions.map((action) => ({
        taskId: task.taskId,
        ...action,
      })),
    ),
    observedAt,
    performsActions: false,
  };
}

/** Narrow replay of the existing readonly48 projection formats; projections never supply authorization. */
export function reconcileProjections({ delivery, inputs, observedAt, scoped }) {
  if (delivery?.reconciliation === undefined) return null;
  const refs = delivery.reconciliation;
  const supported = ["call-budget", "current-status", "candidate-snapshot"];
  const valid =
    scoped &&
    Array.isArray(refs) &&
    refs.length > 0 &&
    refs.length <= 100 &&
    refs.every((ref) => id(ref?.sourceId) && supported.includes(ref.profile)) &&
    new Set(refs.map((ref) => ref.sourceId)).size === refs.length;
  const conflicts = [],
    records = [];
  for (const ref of valid ? refs : []) {
    const matches = inputs.filter((input) => input.id === ref.sourceId),
      source = matches[0],
      data = matches.length === 1 ? parse(source) : null;
    const sourceAt = timestamp(data?.at),
      sources = evidence(source);
    const available = data && sourceAt && Date.parse(sourceAt) <= Date.parse(observedAt);
    const record = {
      sourceId: ref.sourceId,
      profile: ref.profile,
      relation: available ? "recorded-projection" : "unavailable",
      observedAt: sourceAt,
      evidence: sources,
    };
    records.push(record);
    if (!available) continue;
    const conflict = (reason, minimumGap) =>
      conflicts.push({
        reason,
        sourceId: ref.sourceId,
        observedAt: sourceAt,
        minimumGap,
        evidence: sources,
      });
    if (ref.profile === "call-budget") {
      const summary =
        typeof data.currentSQLResult === "string"
          ? data.currentSQLResult.match(/^(\d+) cumulative confirmed SQL\b/)
          : null;
      if (
        summary &&
        count(data.actualCounts?.physicalSQLRequests) &&
        Number(summary[1]) !== data.actualCounts.physicalSQLRequests
      )
        conflict("BUDGET_PROJECTION_CONFLICT", "MATCHING_RECEIPT_COUNTS_AND_PROJECTION_REQUIRED");
      if (
        data.currentWindowActive === false &&
        data.proposedCompanySingleSnapshot?.activated === true &&
        !data.historicalScopeFields?.proposedCompanySingleSnapshot
      )
        conflict("WINDOW_ACTIVATION_CONFLICT", "CLOSED_OR_HISTORIC_WINDOW_CLASSIFICATION_REQUIRED");
      if (
        data.currentWindowActive === false &&
        /^running\b/.test(data.referenceRecovery?.currentRuntime ?? "")
      )
        conflict(
          "RESTORATION_PROJECTION_CONFLICT",
          "SCOPED_TERMINAL_AND_RESTORATION_RECEIPTS_REQUIRED",
        );
      record.counts = Object.fromEntries(
        Object.entries(data.actualCounts ?? {}).filter(
          ([key, value]) =>
            [
              "physicalSQLRequests",
              "businessModelTasks",
              "businessWrites",
              "businessRESTRequests",
              "GEAMetadataRequests",
              "NativeStarts",
            ].includes(key) && count(value),
        ),
      );
      record.unknownPresent =
        Array.isArray(data.unknownRequests) && data.unknownRequests.length > 0;
      record.afterCutoff = "unknown";
    } else if (ref.profile === "current-status") {
      if (data.currentNativeStopped === true && data.sales27Preparation?.activated === true)
        conflict("WINDOW_ACTIVATION_CONFLICT", "CLOSED_OR_HISTORIC_WINDOW_CLASSIFICATION_REQUIRED");
      if (
        data.currentNativeStopped === true &&
        data.installed?.temporaryDeclarationsActive === true
      )
        conflict(
          "RESTORATION_PROJECTION_CONFLICT",
          "SCOPED_TERMINAL_AND_RESTORATION_RECEIPTS_REQUIRED",
        );
      record.runtime = "recorded-projection-only";
    } else {
      record.relation = "historical-source-snapshot";
      record.installedAtCapture = typeof data.installed === "boolean" ? data.installed : "unknown";
      record.currentInstalled = "unknown";
    }
  }
  const status = conflicts.length
    ? "failed"
    : valid && records.every((record) => record.relation !== "unavailable")
      ? "observed"
      : "unknown";
  return {
    status,
    reason: conflicts.length
      ? "PROJECTION_CONFLICT"
      : status === "unknown"
        ? "SCOPED_PROJECTION_INPUT_REQUIRED"
        : "RECORDED_PROJECTION_REPLAY_ONLY",
    minimumGap: status === "observed" ? null : "MATCHING_RECEIPTS_SCOPE_AND_TIME_REQUIRED",
    records,
    conflicts,
    observedAt,
    proof: "projection-consistency-only",
  };
}
