// Pure interpretation of already-read, controlled metadata. No IO or execution.
import { observeTaskTicket } from "./delivery-ticket.mjs";
const id = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
const parse = (input) => {
  try {
    return input?.bytes ? JSON.parse(input.bytes.toString("utf8")) : undefined;
  } catch {
    return undefined;
  }
};
const sources = (input) =>
  input?.sha256
    ? [
        {
          sourceId: input.id,
          sha256: input.sha256,
          observedAt: input.observedAt,
        },
      ]
    : [];
const categories = [
  "test-deployment",
  "tenant",
  "read-scope",
  "login-method",
  "model",
];
const missingReasons = {
  "test-deployment": "TEST_DEPLOYMENT_NOT_DELIVERED",
  tenant: "TENANT_NOT_DELIVERED",
  "read-scope": "READ_SCOPE_NOT_DELIVERED",
  "login-method": "LOGIN_METHOD_NOT_DELIVERED",
  model: "MODEL_REFERENCE_NOT_DELIVERED",
};
const factStates = {
  "local-authentication": [
    "unknown",
    "not-run",
    "authenticated",
    "unauthenticated",
  ],
  "gea-identity": ["unknown", "not-run", "authenticated", "missing", "denied"],
  "consumer-permission": ["unknown", "not-run", "allowed", "denied"],
  dataset: ["unknown", "not-run", "available", "unavailable"],
  query: ["unknown", "not-run", "failed", "empty", "zero", "nonempty"],
  "fixed-data-comparison": ["unknown", "not-run", "matched", "mismatched"],
  "real-model": ["unknown", "not-run", "passed", "failed"],
};
const negativeFacts = {
  "gea-identity:missing": [
    "gea-authorization",
    "blocked",
    "GEA_IDENTITY_MISSING",
  ],
  "gea-identity:denied": [
    "gea-authorization",
    "blocked",
    "GEA_IDENTITY_DENIED",
  ],
  "consumer-permission:denied": [
    "gea-authorization",
    "blocked",
    "CONSUMER_PERMISSION_DENIED",
  ],
  "dataset:unavailable": ["real-data", "blocked", "DATASET_UNAVAILABLE"],
  "query:failed": ["real-data", "failed", "QUERY_FAILED"],
  "fixed-data-comparison:mismatched": [
    "real-data",
    "failed",
    "FIXED_DATA_COMPARISON_FAILED",
  ],
  "real-model:failed": ["model", "failed", "REAL_MODEL_FAILED"],
};
const timestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
function hasSupersessionCycle(entries, roots) {
  const visiting = new Set(),
    visited = new Set();
  const byId = new Map(entries.map((entry) => [entry.sourceId, entry]));
  function visit(sourceId) {
    if (visiting.has(sourceId)) return true;
    if (visited.has(sourceId)) return false;
    visiting.add(sourceId);
    if ((byId.get(sourceId)?.value.supersedes ?? []).some(visit)) return true;
    visiting.delete(sourceId);
    visited.add(sourceId);
    return false;
  }
  return roots.some((entry) => visit(entry.sourceId));
}
function observePolicy(value, stages, evidence) {
  const cleanRound = (round) =>
    round &&
    id(round.roundId) &&
    ["full", "restricted", "unknown"].includes(round.access) &&
    ["never", "on-request", "unknown"].includes(round.approval)
      ? {
          roundId: round.roundId,
          access: round.access,
          approval: round.approval,
        }
      : null;
  const round = cleanRound(value?.current);
  const current =
    round && round.roundId === value.currentRoundId ? round : null;
  const history = (Array.isArray(value?.history) ? value.history : [])
    .map(cleanRound)
    .filter(Boolean);
  const stops = (Array.isArray(value?.stops) ? value.stops : []).map((stop) => {
    const valid =
      stop &&
      id(stop.actionId) &&
      id(stop.roundId) &&
      stages.includes(stop.stage) &&
      ((stop.kind === "model-capacity" &&
        stop.reasonCode === "capacity-limit") ||
        (stop.kind === "approval-rejected" &&
          ["automatic-approval-rejected", "manual-approval-rejected"].includes(
            stop.reasonCode,
          )));
    return {
      actionId: id(stop?.actionId) ? stop.actionId : null,
      stage: stages.includes(stop?.stage) ? stop.stage : null,
      roundId: id(stop?.roundId) ? stop.roundId : null,
      kind: ["model-capacity", "approval-rejected"].includes(stop?.kind)
        ? stop.kind
        : "unknown",
      status: valid ? "blocked" : "unknown",
      reasonCode: valid ? stop.reasonCode : "STOP_ACTION_AND_REASON_REQUIRED",
      relation:
        !id(stop?.roundId) || !current
          ? "unknown"
          : stop.roundId === current.roundId
            ? "current"
            : "historical",
      evidence,
      minimumGap: valid ? null : "STOP_ACTION_SCOPE_ROUND_AND_REASON_REQUIRED",
    };
  });
  const pending = value?.pendingAction;
  const actionLocated =
    pending?.visibility === "available" &&
    id(pending.actionId) &&
    id(pending.roundId) &&
    stages.includes(pending.stage) &&
    ["pending", "rejected", "none"].includes(pending.approvalState);
  const pendingRelation =
    !current || !id(pending?.roundId)
      ? "unknown"
      : pending.roundId === current.roundId
        ? "current"
        : "historical";
  const effectivePolicyKnown =
    current && current.access !== "unknown" && current.approval !== "unknown";
  const available =
    actionLocated && pendingRelation === "current" && effectivePolicyKnown;
  const pendingAction = {
    status: available ? pending.approvalState : "unknown",
    relation: pendingRelation,
    actionId: actionLocated ? pending.actionId : null,
    stage: stages.includes(pending?.stage) ? pending.stage : null,
    reason: available
      ? "RECORDED_PENDING_ACTION"
      : actionLocated && pendingRelation === "current" && !effectivePolicyKnown
        ? "EFFECTIVE_CURRENT_POLICY_REQUIRED"
        : "PENDING_ACTION_AND_CURRENT_POLICY_REQUIRED",
    evidence,
  };
  return {
    current,
    history,
    pendingAction,
    stops,
    proof: "recorded-round-policy",
    observation: "offline-readonly",
  };
}

export function assessReadiness({
  inputs,
  ticket,
  taskId,
  projectId,
  stages,
  observedAt,
  candidateSha256,
  candidateContentSha256,
  candidateValid,
}) {
  const envelopes = inputs.filter(
    (input) => parse(input)?.kind === "authorization-readiness",
  );
  if (!envelopes.length) return null;
  const input = envelopes[0];
  const data = parse(input);
  const unique = (sourceId) => {
    const matching = inputs.filter((input) => input.id === sourceId);
    return matching.length === 1 && matching[0].sha256
      ? matching[0]
      : undefined;
  };
  const valid =
    envelopes.length === 1 &&
    unique(input.id) &&
    data.taskId === taskId &&
    data.projectId === projectId &&
    Array.isArray(data.instructions) &&
    data.instructions.length <= 100 &&
    data.instructions.every(id) &&
    new Set(data.instructions).size === data.instructions.length &&
    inputs.every(
      (input) =>
        !input.id ||
        inputs.filter((other) => other.id === input.id).length === 1,
    );
  const instructions = (
    valid && Array.isArray(data.instructions) ? data.instructions : []
  ).map((sourceId) => {
    const input = unique(sourceId),
      value = parse(input);
    const human =
      value?.kind === "human-instruction" &&
      value.projectId === projectId &&
      value.provenance?.author === "human" &&
      value.provenance?.interface === "official-user-message" &&
      id(value.provenance.threadId) &&
      id(value.provenance.itemId) &&
      Array.isArray(value.taskIds) &&
      value.taskIds.length > 0 &&
      value.taskIds.length <= 100 &&
      value.taskIds.every(id) &&
      Array.isArray(value.stages) &&
      value.stages.length > 0 &&
      value.stages.length <= stages.length &&
      value.stages.every((stage) => stages.includes(stage)) &&
      ["allow", "deny", "pause"].includes(value.effect) &&
      ["manual-work", "automatic-followup", "browser", "review-rule"].includes(
        value.action,
      ) &&
      (value.supersedes === undefined ||
        (Array.isArray(value.supersedes) &&
          value.supersedes.length <= 100 &&
          value.supersedes.every(id))) &&
      (value.dependencyExceptions === undefined ||
        (Array.isArray(value.dependencyExceptions) &&
          value.dependencyExceptions.length <= 100 &&
          value.dependencyExceptions.every(id)));
    return { sourceId, input, value, human };
  });
  const lines = [
    ...(ticket.bytes?.toString("utf8") ?? "").matchAll(
      /^\*\*Blocked by:\*\*\s*(.+)$/gm,
    ),
  ];
  const body = lines.length === 1 ? lines[0][1] : "";
  const predecessorIds = /^(?:None\b|无(?:[。.\s]|$))/.test(body)
    ? []
    : body.split(/[；;]/).flatMap((part) => {
        const match = part.trim().match(/^(\d{1,2})(?:[：:]|\s|$)/);
        return match ? [match[1]] : [];
      });
  const parsedDependencies =
    lines.length === 1 &&
    (/^(?:None\b|无(?:[。.\s]|$))/.test(body) ||
      predecessorIds.length === body.split(/[；;]/).length);
  const predecessors = [...new Set(predecessorIds)].map((predecessorId) => {
    const references = (
      valid && Array.isArray(data.predecessors) ? data.predecessors : []
    ).filter((entry) => entry?.taskId === predecessorId);
    const source =
      references.length === 1 ? unique(references[0].sourceId) : undefined;
    const executionStatus = observeTaskTicket(source, predecessorId).status;
    return {
      taskId: predecessorId,
      executionStatus,
      status:
        executionStatus === "done"
          ? "satisfied"
          : executionStatus === "unknown"
            ? "unknown"
            : "blocked",
      evidence: sources(source),
    };
  });
  const dependencyStatus =
    !valid || !parsedDependencies
      ? "unknown"
      : predecessors.some((entry) => entry.status === "unknown")
        ? "unknown"
        : predecessors.some((entry) => entry.status === "blocked")
          ? "blocked"
          : "satisfied";
  const permissionFor = (stage, action) => {
    const scoped = instructions.filter(
      (entry) =>
        !entry.value ||
        !Array.isArray(entry.value.taskIds) ||
        !Array.isArray(entry.value.stages) ||
        (entry.value.taskIds.includes(taskId) &&
          entry.value.stages.includes(stage) &&
          entry.value.action === action),
    );
    const relevant = scoped.filter((entry) => entry.human);
    const invalidSource = scoped.some((entry) => !entry.human);
    const invalidSupersession =
      hasSupersessionCycle(
        instructions.filter((entry) => entry.human),
        relevant,
      ) ||
      relevant.some((entry) =>
        (entry.value.supersedes ?? []).some(
          (sourceId) =>
            sourceId === entry.sourceId ||
            !instructions.some((old) => old.human && old.sourceId === sourceId),
        ),
      );
    const active = relevant.filter(
      (entry) =>
        !relevant.some((newer) =>
          newer.value.supersedes?.includes(entry.sourceId),
        ),
    );
    const conflict =
      new Set(active.map((entry) => entry.value.effect)).size > 1 ||
      (relevant.length > 0 && !active.length);
    const stopped = active.some((entry) => entry.value.effect !== "allow");
    const status =
      !valid ||
      invalidSource ||
      invalidSupersession ||
      conflict ||
      !active.length
        ? "unknown"
        : stopped
          ? "blocked"
          : "allowed";
    const reason = !valid
      ? "READINESS_SCOPE_OR_SOURCE_CONFLICT"
      : invalidSource || !relevant.length
        ? "HUMAN_SOURCE_AND_SCOPE_REQUIRED"
        : invalidSupersession || conflict
          ? "HUMAN_PERMISSION_CONFLICT"
          : stopped
            ? "HUMAN_PERMISSION_STOPPED"
            : "RECORDED_HUMAN_PERMISSION";
    return {
      stage,
      action,
      status,
      reason,
      active,
      dependencyExceptions:
        status === "allowed"
          ? [
              ...new Set(
                active.flatMap(
                  (entry) => entry.value.dependencyExceptions ?? [],
                ),
              ),
            ]
          : [],
      stopEffects:
        status === "blocked"
          ? [...new Set(active.map((entry) => entry.value.effect))].filter(
              (effect) => effect !== "allow",
            )
          : [],
      evidence: scoped.flatMap((entry) => sources(entry.input)),
      proof: "recorded-human-reference",
    };
  };
  const authorization = stages.map((stage) => {
    const { active, ...permission } = permissionFor(stage, "manual-work");
    return permission;
  });
  const arrangements = ["automatic-followup", "browser"].flatMap((action) =>
    stages.map((stage) => {
      const { active, ...permission } = permissionFor(stage, action);
      return permission;
    }),
  );
  let review = null;
  if (data.review !== undefined) {
    const permission = permissionFor("offline-checks", "review-rule");
    const modes = [
      ...new Set(permission.active.map((entry) => entry.value.reviewMode)),
    ];
    const mode =
      permission.status === "allowed" &&
      modes.length === 1 &&
      ["internal-final", "external-final"].includes(modes[0])
        ? modes[0]
        : "unknown";
    const reviewInput = valid ? unique(data.review?.sourceId) : undefined;
    const record = parse(reviewInput);
    const current =
      mode === "internal-final" &&
      candidateValid &&
      record?.kind === "internal-review" &&
      record.taskId === taskId &&
      record.projectId === projectId &&
      record.scope === "final-candidate" &&
      ["standards", "spec", "taste"].every(
        (axis) => record[axis] === "passed",
      ) &&
      record.candidateSha256 === candidateSha256 &&
      record.candidateContentSha256 === candidateContentSha256 &&
      Array.isArray(record.inputs) &&
      record.inputs.every(
        (ref) =>
          id(ref?.sourceId) && unique(ref.sourceId)?.sha256 === ref.sha256,
      ) &&
      new Set(record.inputs.map((ref) => ref.sourceId)).size ===
        record.inputs.length &&
      Array.isArray(data.review.requiredInputs) &&
      data.review.requiredInputs.every(
        (sourceId) =>
          id(sourceId) &&
          record.inputs.some((ref) => ref.sourceId === sourceId),
      );
    review = {
      status: current
        ? "satisfied"
        : mode === "external-final"
          ? "blocked"
          : "unknown",
      rule: mode,
      reason: current
        ? "FINAL_INTERNAL_REVIEW_REUSED"
        : mode === "external-final"
          ? "EXTERNAL_REVIEW_EVIDENCE_REQUIRED"
          : "INTERNAL_REVIEW_CANDIDATE_OR_INPUT_MISMATCH",
      evidence: [...permission.evidence, ...sources(reviewInput)],
      proof: "recorded-review",
    };
  }
  const configuration = categories.map((category) => {
    const entries = (
      valid && Array.isArray(data.configuration) ? data.configuration : []
    ).filter((entry) => entry?.category === category);
    const entry = entries[0];
    const validEntry =
      entries.length === 1 &&
      ["ready", "missing", "unknown", "denied"].includes(entry.status) &&
      [
        "mock",
        "receipt",
        "placeholder",
        "real-readonly",
        "real-write",
      ].includes(entry.mode) &&
      (entry.status !== "ready" || id(entry.referenceId)) &&
      (category !== "read-scope" ||
        entry.status !== "ready" ||
        (Array.isArray(entry.scope) &&
          entry.scope.length > 0 &&
          entry.scope.every(id)));
    const status = validEntry ? entry.status : "unknown";
    return {
      category,
      status,
      mode: validEntry ? entry.mode : "unknown",
      referenceId:
        validEntry && id(entry.referenceId) ? entry.referenceId : null,
      scope:
        validEntry && category === "read-scope" && Array.isArray(entry.scope)
          ? entry.scope.filter(id)
          : [],
      reason:
        status === "ready"
          ? "CONFIGURATION_METADATA_PRESENT"
          : status === "denied"
            ? "CONFIGURATION_ACCESS_DENIED"
            : status === "missing"
              ? missingReasons[category]
              : "CONFIGURATION_METADATA_REQUIRED",
      owner: "configuration-owner",
      evidence: sources(input),
      proof: "readiness-metadata-only",
    };
  });
  const requirements =
    valid && Array.isArray(data.requirements) ? data.requirements : [];
  const configGaps = stages.flatMap((stage) => {
    const entries = requirements.filter((entry) => entry?.stage === stage);
    if (!entries.length) return [];
    const entry = entries[0];
    if (
      entries.length !== 1 ||
      !Array.isArray(entry.needs) ||
      !entry.needs.length ||
      !entry.needs.every((category) => categories.includes(category)) ||
      new Set(entry.needs).size !== entry.needs.length
    )
      return [
        {
          stage,
          status: "unknown",
          reason: "CONFIGURATION_REQUIREMENTS_INVALID",
          owner: "configuration-owner",
          evidence: sources(input),
        },
      ];
    return entry.needs.flatMap((category) => {
      const config = configuration.find((item) => item.category === category);
      if (
        config.status === "ready" &&
        (config.mode === "real-readonly" ||
          (["source-candidate", "offline-checks"].includes(stage) &&
            ["mock", "receipt", "placeholder"].includes(config.mode)))
      )
        return [];
      return [
        {
          stage,
          category,
          status: config.status === "unknown" ? "unknown" : "blocked",
          reason:
            config.status === "ready"
              ? config.mode === "real-write"
                ? "READONLY_CONFIGURATION_REQUIRED"
                : "REAL_CONFIGURATION_REQUIRED"
              : config.reason,
          owner: config.owner,
          evidence: config.evidence,
        },
      ];
    });
  });
  const facts = Object.entries(factStates).map(([fact, states]) => {
    const entries = (
      valid && Array.isArray(data.observations) ? data.observations : []
    ).filter((entry) => entry?.fact === fact);
    const entry = entries[0];
    const recordValid =
      entries.length === 1 &&
      states.includes(entry.state) &&
      timestamp(entry.observedAt) &&
      Date.parse(entry.observedAt) <= Date.parse(observedAt) &&
      id(entry.runId) &&
      id(entry.combinationId) &&
      id(entry.ownerId);
    const current =
      recordValid &&
      candidateValid &&
      entry.candidateSha256 === candidateSha256;
    return {
      fact,
      state: current ? entry.state : "unknown",
      relation: !recordValid
        ? entries.length > 1
          ? "conflict"
          : "unavailable"
        : current
          ? "current"
          : "candidate-mismatch",
      runId: recordValid ? entry.runId : null,
      combinationId: recordValid ? entry.combinationId : null,
      ownerId: recordValid ? entry.ownerId : null,
      observedAt: recordValid ? entry.observedAt : null,
      evidence: sources(input),
      proof: "recorded-readiness-observation",
    };
  });
  const factGaps = facts.flatMap((fact) => {
    const gap = negativeFacts[`${fact.fact}:${fact.state}`];
    return gap
      ? [
          {
            stage: gap[0],
            status: gap[1],
            reason: gap[2],
            owner: "original-execution-owner",
            evidence: fact.evidence,
          },
        ]
      : [];
  });
  const executionPolicy = observePolicy(
    valid ? data.executionPolicy : undefined,
    stages,
    sources(input),
  );
  const policyGaps = executionPolicy.stops
    .filter((stop) => stop.stage && stop.relation !== "historical")
    .map((stop) => ({
      stage: stop.stage,
      status: stop.relation === "current" ? stop.status : "unknown",
      reason:
        stop.relation !== "current" || stop.status === "unknown"
          ? "STOP_ACTION_SCOPE_ROUND_AND_REASON_REQUIRED"
          : stop.kind === "model-capacity"
            ? "MODEL_CAPACITY_STOP"
            : stop.reasonCode === "automatic-approval-rejected"
              ? "AUTOMATIC_APPROVAL_REJECTED"
              : "MANUAL_APPROVAL_REJECTED",
      actionId: stop.actionId,
      owner:
        stop.kind === "model-capacity"
          ? "model-platform-owner"
          : "approval-owner",
      evidence: stop.evidence,
    }));
  if (
    executionPolicy.pendingAction.relation !== "historical" &&
    executionPolicy.pendingAction.stage &&
    ["pending", "rejected", "unknown"].includes(
      executionPolicy.pendingAction.status,
    )
  )
    policyGaps.push({
      stage: executionPolicy.pendingAction.stage,
      status:
        executionPolicy.pendingAction.status === "unknown"
          ? "unknown"
          : "blocked",
      reason:
        executionPolicy.pendingAction.status === "unknown"
          ? executionPolicy.pendingAction.reason ===
            "EFFECTIVE_CURRENT_POLICY_REQUIRED"
            ? "EFFECTIVE_CURRENT_POLICY_REQUIRED"
            : "PENDING_ACTION_UNAVAILABLE"
          : executionPolicy.pendingAction.status === "pending"
            ? "ACTION_APPROVAL_PENDING"
            : "ACTION_APPROVAL_REJECTED",
      actionId: executionPolicy.pendingAction.actionId,
      owner: "approval-owner",
      evidence: executionPolicy.pendingAction.evidence,
    });
  const suggestions = authorization.map((permission) => {
    const exception =
      permission.status === "allowed" &&
      dependencyStatus === "blocked" &&
      predecessors
        .filter((entry) => entry.status !== "satisfied")
        .every((entry) =>
          permission.dependencyExceptions.includes(entry.taskId),
        );
    const dependencyReady = dependencyStatus === "satisfied" || exception;
    const reviewGap =
      review &&
      review.status !== "satisfied" &&
      permission.stage === "offline-checks"
        ? { ...review, status: review.status, owner: "review-owner" }
        : undefined;
    const browser = arrangements.find(
      (entry) =>
        entry.stage === permission.stage &&
        entry.action === "browser" &&
        entry.status !== "allowed" &&
        entry.evidence.length,
    );
    const browserGap = browser
      ? {
          ...browser,
          reason:
            browser.status === "blocked"
              ? "BROWSER_WINDOW_PAUSED"
              : "BROWSER_PERMISSION_SCOPE_REQUIRED",
          owner: "browser-owner",
        }
      : undefined;
    const gap =
      [...policyGaps].find((entry) => entry.stage === permission.stage) ??
      browserGap ??
      reviewGap ??
      [...factGaps, ...configGaps].find(
        (entry) => entry.stage === permission.stage,
      );
    const status =
      permission.status === "blocked" ||
      (dependencyStatus === "blocked" && !exception) ||
      ["blocked", "failed"].includes(gap?.status)
        ? "blocked"
        : permission.status === "allowed" && dependencyReady && !gap
          ? "can-continue"
          : "unknown";
    const reason =
      gap?.reason ??
      (permission.status !== "allowed"
        ? permission.reason
        : !dependencyReady
          ? "PREDECESSOR_DONE_REQUIRED"
          : exception
            ? "TARGET_STAGE_EXCEPTION"
            : "AUTHORIZED_STAGE_READY");
    return {
      stage: permission.stage,
      action: "manual-work",
      status,
      reason,
      owner: gap?.owner ?? "task-owner",
      minimumGap: status === "can-continue" ? null : reason,
      evidence: [
        ...permission.evidence,
        ...predecessors.flatMap((entry) => entry.evidence),
        ...(gap?.evidence ?? []),
      ],
    };
  });
  return {
    authorization,
    arrangements,
    dependencies: {
      status: dependencyStatus,
      predecessors,
      evidence: sources(ticket),
    },
    configuration,
    configGaps,
    facts,
    factGaps,
    review,
    executionPolicy,
    policyGaps,
    suggestions,
    observedAt,
  };
}
