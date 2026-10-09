/** Interprets bounded, sanitized formal records; never observes a live service. */
const id = (v) =>
  typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(v);
const timestamp = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v));
const sha = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
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
const parse = (input) => {
  try {
    return JSON.parse(input.bytes);
  } catch {
    return null;
  }
};
const factStates = {
  service: ["started", "failed", "exited"],
  "process-group": ["all-exited", "running"],
  "native-gate": ["http-401", "opened"],
  "local-authentication": ["authenticated", "unauthenticated"],
  "gea-identity": ["authenticated", "missing", "denied"],
  "consumer-permission": ["allowed", "denied"],
  dataset: ["available", "unavailable"],
  query: ["nonempty", "empty", "zero", "failed"],
  "fixed-data-comparison": ["matched", "mismatched"],
  "real-model": ["passed", "failed"],
  "page-reference": ["passed", "failed"],
  "agent-readonly": ["passed", "denied"],
  "model-reference": ["passed", "failed"],
  "native-reference": ["passed", "failed"],
  "cancel-revoke": ["passed", "failed"],
  "session-entity-recovery": ["passed", "failed"],
  "combination-recovery": ["passed", "failed"],
};
function runGap(run) {
  return {
    stage: "service-structure",
    status: ["candidate-mismatch", "selection-mismatch"].includes(run.relation)
      ? "blocked"
      : "unknown",
    reason:
      run.relation === "selection-mismatch"
        ? "RUN_SELECTED_COMBINATION_MISMATCH"
        : "SCOPED_CANDIDATE_RUN_AND_OWNERS_REQUIRED",
    owner: "service-owner",
    minimumGap: "SELECTED_COMBINATION_RUN_EVIDENCE_REQUIRED",
    evidence: run.evidence,
  };
}
export async function assessRuntime({
  inputs,
  task,
  projectId,
  observedAt,
  candidate,
  readScope,
  results,
  assembly,
  candidateSha256,
  candidateContentSha256,
  readiness,
  taskValid,
}) {
  const records = inputs.map((input) => ({ input, data: parse(input) }));
  const roots = records.filter((v) => v.data?.kind === "runtime-evidence");
  const hasRuntime = roots.length > 0;
  if (!hasRuntime && !readiness) return null;
  const uniqueInputs = new Set(inputs.map((v) => v.id)).size === inputs.length;
  const root = roots[0] ?? { data: { taskId: task.id, projectId } };
  const scoped =
    taskValid &&
    roots.length === 1 &&
    uniqueInputs &&
    root.data.taskId === task.id &&
    root.data.projectId === projectId;
  const get = (sourceId, kind) => {
    const matches = records.filter((v) => v.input.id === sourceId);
    const record = matches[0],
      d = record?.data;
    // Historical document replay is limited to repair declarations. It cannot
    // supply execution ownership, authorization, run facts or human item IDs.
    if (kind === "technical-repair" && d?.observation === "document-capture") {
      const original = inputs.filter((v) => v.id === d.provenance?.sourceId);
      const text = original[0]?.bytes?.toString("utf8") ?? "";
      const profiles = {
        16: ["分页截断及跨页字段权限P2均已修复", /Workbench最终([a-f0-9]{40})/],
        26: ["两项源码缺陷已关闭", /固定候选\s*`([a-f0-9]{40})`/],
        27: ["均已修复并按最终SHA复审至0", /\|Workbench\|([a-f0-9]{40})\|/],
        22: ["新增只读注册mock资源可用投影", /GEA新增候选\s*`([a-f0-9]{40})`/],
      };
      const profile = Object.hasOwn(profiles, task.id)
          ? profiles[task.id]
          : undefined,
        commits = profile
          ? [...text.matchAll(new RegExp(profile[1].source, "g"))]
          : [];
      if (
        scoped &&
        matches.length === 1 &&
        d?.kind === kind &&
        d.taskId === task.id &&
        d.projectId === projectId &&
        d.provenance?.interface === "normalized-document-capture" &&
        id(d.provenance.sourceId) &&
        original.length === 1 &&
        sha(d.provenance.sha256) &&
        original[0].sha256 === d.provenance.sha256 &&
        timestamp(d.provenance.observedAt) &&
        timestamp(d.observedAt) &&
        Date.parse(d.provenance.observedAt) <= Date.parse(d.observedAt) &&
        Date.parse(d.observedAt) <= Date.parse(observedAt) &&
        profile &&
        text.includes(profile[0]) &&
        commits.length === 1 &&
        commits[0][1] === candidate?.commit &&
        !/修复未完成|缺陷未关闭|尚未修复|尚未关闭|均未修复/.test(text) &&
        (task.id !== "22" ||
          (text.includes("类型和client构建退出0") &&
            text.includes("内部增量复审0/0/0")))
      )
        return { ...record, boundSource: original[0], documentCapture: true };
      return null;
    }
    return scoped &&
      matches.length === 1 &&
      d?.kind === kind &&
      d.taskId === task.id &&
      d.projectId === projectId &&
      timestamp(d.observedAt) &&
      Date.parse(d.observedAt) <= Date.parse(observedAt) &&
      ["historical", "official-snapshot", "live"].includes(d.observation) &&
      [
        "official-tool-result",
        "official-owner-handoff",
        "official-live-observer",
      ].includes(d.provenance?.interface) &&
      (d.observation !== "live" ||
        d.provenance.interface === "official-live-observer") &&
      (!["execution-ownership", "execution-tool-state"].includes(kind) ||
        d.provenance.interface !== "official-owner-handoff") &&
      id(d.provenance?.threadId) &&
      id(d.provenance?.itemId)
      ? record
      : null;
  };
  const entry = get(root.data.ownership, "execution-ownership"),
    d = entry?.data;
  let ownership = {
    status: "unknown",
    reason: "ACTUAL_TASK_PROJECT_CHECKOUT_AND_WRITERS_REQUIRED",
    taskId: task.id,
    threadId: null,
    actualProjectId: null,
    writers: [],
    evidence: sources(entry?.input),
  };
  if (
    d &&
    d.observation !== "historical" &&
    d.actualTaskId === task.id &&
    d.actualProjectId === projectId &&
    id(d.threadId) &&
    d.threadId === d.provenance.threadId &&
    typeof d.checkout === "string" &&
    candidate?.checkout &&
    Array.isArray(d.writers) &&
    d.writers.length > 0 &&
    d.writers.length <= 100 &&
    d.writers.every(
      (v) =>
        v &&
        v.taskId === task.id &&
        id(v.threadId) &&
        id(v.roundId) &&
        ["active", "idle", "unknown"].includes(v.state),
    ) &&
    d.writers.some((v) => v.threadId === d.threadId)
  ) {
    try {
      if (
        (await readScope.resolve(d.checkout)) ===
        (await readScope.resolve(candidate.checkout.path))
      ) {
        const conflict =
          d.writers.some(
            (v) => v.state === "active" && v.threadId !== d.threadId,
          ) || d.writers.filter((v) => v.state === "active").length > 1;
        ownership = {
          ...ownership,
          status: conflict
            ? "blocked"
            : d.writers.some((v) => v.state === "unknown")
              ? "unknown"
              : "matched",
          reason: conflict
            ? "IN_FLIGHT_WRITER_CONFLICT"
            : d.writers.some((v) => v.state === "unknown")
              ? "WRITER_OCCUPANCY_UNKNOWN"
              : "ACTUAL_EXECUTION_BINDING_MATCH",
          threadId: d.threadId,
          actualProjectId: d.actualProjectId,
          writers: d.writers.map(({ taskId, threadId, roundId, state }) => ({
            taskId,
            threadId,
            roundId,
            state,
          })),
          observedAt: d.observedAt,
          observation: d.observation,
          proof: "recorded-formal-ownership",
        };
      }
    } catch {
      /* Scope failures remain unknown without exposing raw paths. */
    }
  }
  const list = (field, kind) => {
    const refs = root.data[field] ?? [];
    if (
      !Array.isArray(refs) ||
      refs.length > 100 ||
      refs.some((v) => !id(v)) ||
      new Set(refs).size !== refs.length
    )
      return [{ record: null, sourceId: "invalid-reference" }];
    return refs.map((sourceId) => ({ sourceId, record: get(sourceId, kind) }));
  };
  const handoffs = list("handoffs", "delivery-handoff").map(
    ({ sourceId, record }) => {
      const d = record?.data;
      const valid =
        d &&
        d.deliveryId === task.delivery?.id &&
        sha(d.deliverySha256) &&
        inputs.some(
          (v) => v.id === d.deliveryId && v.sha256 === d.deliverySha256,
        ) &&
        d.candidateSha256 === candidateSha256 &&
        d.candidateContentSha256 === candidateContentSha256 &&
        ownership.status === "matched" &&
        d.recipientThreadId === ownership.threadId &&
        ["sent", "received", "delivered", "failed", "unknown"].includes(
          d.state,
        );
      return {
        sourceId,
        state: valid ? d.state : "unknown",
        deliveryId: valid ? d.deliveryId : null,
        recipientThreadId: valid ? d.recipientThreadId : null,
        reason: valid
          ? d.state === "unknown"
            ? "FORMAL_DELIVERY_RESULT_REQUIRED"
            : "RECORDED_HANDOFF_FACT"
          : "SCOPED_FORMAL_HANDOFF_REQUIRED",
        observation: record?.data.observation ?? null,
        observedAt: record?.data.observedAt ?? null,
        proof: "recorded-formal-handoff",
        owner: "handoff-owner",
        minimumGap:
          valid && d.state !== "unknown"
            ? null
            : valid
              ? "FORMAL_DELIVERY_RESULT_REQUIRED"
              : "SCOPED_FORMAL_HANDOFF_REQUIRED",
        recordedState:
          d &&
          ["sent", "received", "delivered", "failed", "unknown"].includes(
            d.state,
          )
            ? d.state
            : "unknown",
        relation: !valid
          ? "unavailable"
          : d.observation === "historical"
            ? "historical"
            : "candidate-matched",
        evidence: sources(record?.input),
      };
    },
  );
  const tools = list("tools", "execution-tool-state").map(
    ({ sourceId, record }) => {
      const d = record?.data;
      const valid = d && id(d.actionId) && id(d.roundId);
      const command =
        valid &&
        ["running", "exited", "failed", "unknown"].includes(d.command) &&
        (d.command !== "exited" || Number.isSafeInteger(d.exitCode))
          ? {
              state: d.command,
              exitCode: d.command === "exited" ? d.exitCode : null,
            }
          : { state: "unknown", exitCode: null };
      const pending =
        valid &&
        d.pendingAction?.visibility === "available" &&
        d.pendingAction.supported === true &&
        id(d.pendingAction.actionId) &&
        d.pendingAction.roundId === d.roundId &&
        results.some((v) => v.stage === d.pendingAction.stage)
          ? {
              state: "available",
              actionId: d.pendingAction.actionId,
              roundId: d.roundId,
              stage: d.pendingAction.stage,
            }
          : { state: "unknown" };
      const live =
        valid &&
        d.observation === "live" &&
        d.provenance.interface === "official-live-observer" &&
        d.observedAt === observedAt;
      return {
        sourceId,
        actionId: valid ? d.actionId : null,
        roundId: valid ? d.roundId : null,
        command,
        turn:
          valid &&
          ["running", "completed", "failed", "unknown"].includes(d.turn)
            ? d.turn
            : "unknown",
        uiTimer:
          valid && ["running", "stopped", "unknown"].includes(d.uiTimer)
            ? d.uiTimer
            : "unknown",
        pendingAction: pending,
        stopInterface:
          valid && d.stopInterface === "supported" ? "supported" : "unknown",
        process: {
          state:
            live &&
            d.supportedPID === true &&
            Number.isSafeInteger(d.pid) &&
            d.pid > 0
              ? "recorded-live-owner"
              : "unknown",
        },
        reason:
          command.state === "exited" && d.uiTimer === "running"
            ? "TOOL_TERMINAL_UI_TIMER_CONFLICT"
            : "SEPARATE_COMMAND_TURN_UI_FACTS",
        observation: record?.data.observation ?? null,
        observedAt: record?.data.observedAt ?? null,
        proof: "recorded-formal-tool-state",
        evidence: sources(record?.input),
      };
    },
  );
  const service = results.find((v) => v.stage === "service-structure");
  if (service.status === "not-run")
    Object.assign(service, {
      status: "unknown",
      reason: "SCOPED_RUN_AND_LISTENER_OWNER_REQUIRED",
      minimumGap: "SELECTED_COMBINATION_RUN_EVIDENCE_REQUIRED",
    });
  const declaredPersistent = [
    task.session,
    ...(Array.isArray(task.persistentRoots) ? task.persistentRoots : []),
  ]
    .filter(Boolean)
    .map((v) => v.id);
  const runs = list("runs", "runtime-observation").map(
    ({ sourceId, record }) => {
      const d = record?.data;
      const valid =
        d &&
        id(d.runId) &&
        id(d.combinationId) &&
        sha(d.manifestSha256) &&
        sha(d.selectionSha256) &&
        sha(d.candidateSha256) &&
        sha(d.candidateContentSha256) &&
        id(d.lifecycleOwnerId) &&
        id(d.browserOwnerId) &&
        Array.isArray(d.persistentSourceIds) &&
        d.persistentSourceIds.length > 0 &&
        d.persistentSourceIds.length <= 100 &&
        new Set(d.persistentSourceIds).size === d.persistentSourceIds.length &&
        d.persistentSourceIds.every(
          (v) => id(v) && declaredPersistent.includes(v),
        ) &&
        declaredPersistent.every((v) => d.persistentSourceIds.includes(v)) &&
        ["real-readonly", "mock", "receipt", "fixture"].includes(d.mode);
      const relation = !valid
        ? "unavailable"
        : d.observation === "historical"
          ? "historical"
          : d.candidateSha256 !== candidateSha256 ||
              d.candidateContentSha256 !== candidateContentSha256
            ? "candidate-mismatch"
            : assembly?.status !== "passed" ||
                results.find((v) => v.stage === "frozen-assembly").status !==
                  "passed"
              ? "assembly-unverified"
              : d.combinationId !== assembly.combinationId ||
                  d.manifestSha256 !== assembly.manifestSha256 ||
                  d.selectionSha256 !== assembly.selectionSha256
                ? "selection-mismatch"
                : ownership.status !== "matched" ||
                    d.browserOwnerId !== ownership.threadId
                  ? "ownership-unverified"
                  : "selected";
      const facts =
        valid && Array.isArray(d.facts) && d.facts.length <= 100
          ? Object.entries(factStates).map(([fact, states]) => {
              const entries = d.facts.filter((v) => v?.fact === fact),
                entry = entries[0];
              return {
                fact,
                state:
                  entries.length === 1 &&
                  [...states, "unknown", "not-run"].includes(entry.state)
                    ? entry.state
                    : "unknown",
                relation:
                  entries.length > 1
                    ? "conflict"
                    : entries.length === 1
                      ? "recorded"
                      : "unavailable",
              };
            })
          : [];
      return {
        sourceId,
        relation,
        runId: valid ? d.runId : null,
        combinationId: valid ? d.combinationId : null,
        lifecycleOwnerId: valid ? d.lifecycleOwnerId : null,
        browserOwnerId: valid ? d.browserOwnerId : null,
        persistentSourceIds: valid ? d.persistentSourceIds : [],
        mode: valid ? d.mode : null,
        observation: record?.data.observation ?? null,
        observedAt: record?.data.observedAt ?? null,
        facts,
        proof: "recorded-scoped-runtime-evidence",
        evidence: sources(record?.input),
      };
    },
  );
  const selected = runs.filter((v) => v.relation === "selected");
  const current = {
    listener: "unknown",
    localAuthentication: "unknown",
    geaIdentity: "unknown",
    processesExited: "unknown",
    observedAt: null,
  };
  const run = selected.length === 1 ? selected[0] : null;
  const problem = runs.find(
    (v) => !["selected", "historical"].includes(v.relation),
  );
  const readinessGapStages = new Set(
    [
      ...(readiness?.configGaps ?? []),
      ...(readiness?.policyGaps ?? []),
      ...(readiness?.factGaps ?? []),
    ].map((v) => v.stage),
  );
  const conflictGap =
    selected.length > 1
      ? {
          stage: "service-structure",
          status: "unknown",
          reason: "RUN_RECORD_CONFLICT",
          owner: "service-owner",
          minimumGap: "UNIQUE_SELECTED_RUN_REQUIRED",
          evidence: selected.flatMap((v) => v.evidence),
        }
      : null;
  const stoppedService =
    ["failed", "blocked"].includes(service.status) ||
    readinessGapStages.has(service.stage);
  if (conflictGap && !stoppedService) Object.assign(service, conflictGap);
  else if (problem && !stoppedService) Object.assign(service, runGap(problem));
  else if (run && !problem && !stoppedService) {
    const facts = run.facts.filter((v) => v.fact === "service"),
      fact = facts[0];
    if (facts.length === 1 && ["started", "failed"].includes(fact.state))
      Object.assign(service, {
        status: fact.state === "started" ? "passed" : "failed",
        reason:
          fact.state === "started"
            ? "SCOPED_SERVICE_START_RECORDED"
            : "SERVICE_START_FAILED",
        minimumGap:
          fact.state === "started" ? null : "SERVICE_START_EVIDENCE_REQUIRED",
        proof: run.proof,
        evidence: run.evidence,
        observedAt: run.observedAt,
        owner: run.lifecycleOwnerId,
      });
  }
  if (run && !problem && selected.length === 1) {
    const state = (fact) => run.facts.find((v) => v.fact === fact)?.state;
    const update = (name, status, reason) => {
      const target = results.find((v) => v.stage === name);
      if (["failed", "blocked", "not-applicable"].includes(target.status))
        return;
      if (status === "passed" && readinessGapStages.has(name)) return;
      if (status === "passed" && service.status !== "passed") return;
      Object.assign(target, {
        status,
        reason,
        minimumGap: status === "passed" ? null : reason,
        owner: run.browserOwnerId,
        evidence: run.evidence,
        observedAt: run.observedAt,
        proof: run.proof,
      });
    };
    if (run.mode === "real-readonly") {
      if (state("local-authentication") === "authenticated")
        update(
          "local-authentication",
          "passed",
          "LOCAL_HTTP_AUTHENTICATION_RECORDED",
        );
      else if (state("local-authentication") === "unauthenticated")
        update(
          "local-authentication",
          "blocked",
          "LOCAL_HTTP_AUTHENTICATION_REQUIRED",
        );
      if (state("gea-identity") === "denied")
        update("gea-authorization", "blocked", "GEA_IDENTITY_DENIED");
      else if (state("consumer-permission") === "denied")
        update("gea-authorization", "blocked", "CONSUMER_PERMISSION_DENIED");
      else if (
        state("gea-identity") === "authenticated" &&
        state("consumer-permission") === "allowed"
      )
        update(
          "gea-authorization",
          "passed",
          "SCOPED_GEA_AND_CONSUMER_PERMISSION_RECORDED",
        );
      if (state("dataset") === "unavailable")
        update("real-data", "blocked", "DATASET_UNAVAILABLE");
      else if (state("query") === "failed")
        update("real-data", "failed", "REAL_QUERY_FAILED");
      else if (state("fixed-data-comparison") === "mismatched")
        update("real-data", "failed", "FIXED_DATA_COMPARISON_FAILED");
      else if (
        state("gea-identity") === "authenticated" &&
        state("consumer-permission") === "allowed" &&
        state("dataset") === "available" &&
        ["nonempty", "empty", "zero"].includes(state("query")) &&
        state("fixed-data-comparison") === "matched"
      )
        update(
          "real-data",
          "passed",
          "SCOPED_REAL_QUERY_AND_COMPARISON_RECORDED",
        );
      if (state("real-model") === "passed")
        update("model", "passed", "SCOPED_REAL_MODEL_RESULT_RECORDED");
      else if (state("real-model") === "failed")
        update("model", "failed", "REAL_MODEL_FAILED");
      const native = [
        "page-reference",
        "agent-readonly",
        "model-reference",
        "native-reference",
        "cancel-revoke",
      ];
      if (native.every((fact) => state(fact) === "passed"))
        update(
          "native-reference",
          "passed",
          "SCOPED_PAGE_AGENT_REFERENCES_AND_CANCEL_RECORDED",
        );
      else if (
        native.some((fact) => ["failed", "denied"].includes(state(fact)))
      )
        update(
          "native-reference",
          "failed",
          "NATIVE_REFERENCE_OR_CANCEL_FAILED",
        );
      if (state("session-entity-recovery") === "passed")
        update(
          "session-recovery",
          "passed",
          "SCOPED_SESSION_ENTITY_RESTORE_RECORDED",
        );
      else if (state("session-entity-recovery") === "failed")
        update("session-recovery", "failed", "SESSION_ENTITY_RESTORE_FAILED");
      if (state("combination-recovery") === "passed")
        update(
          "combination-recovery",
          "passed",
          "SCOPED_CODE_COMBINATION_RESTORE_RECORDED",
        );
      else if (state("combination-recovery") === "failed")
        update(
          "combination-recovery",
          "failed",
          "CODE_COMBINATION_RESTORE_FAILED",
        );
    }
    if (run.observation === "live" && run.observedAt === observedAt) {
      current.observedAt = run.observedAt;
      current.listener = state("service") === "started" ? "started" : "unknown";
      current.processesExited =
        state("process-group") === "all-exited" ? "all-exited" : "unknown";
      if (run.mode === "real-readonly") {
        current.localAuthentication = [
          "authenticated",
          "unauthenticated",
        ].includes(state("local-authentication"))
          ? state("local-authentication")
          : "unknown";
        current.geaIdentity = ["authenticated", "missing", "denied"].includes(
          state("gea-identity"),
        )
          ? state("gea-identity")
          : "unknown";
      }
    }
  }
  const suggestions = readiness?.suggestions.map((suggestion) => {
    const allowedScope =
      readiness.authorization.find((v) => v.stage === suggestion.stage)
        ?.status ?? "unknown";
    const base = { ...suggestion, allowedScope };
    if (suggestion.status !== "can-continue") return base;
    const source = results.find((v) => v.stage === "source-candidate"),
      frozen = results.find((v) => v.stage === "frozen-assembly");
    const target = results.find((v) => v.stage === suggestion.stage);
    let gap;
    if (
      ownership.status !== "matched" &&
      (hasRuntime ||
        ![
          "source-candidate",
          "offline-checks",
          "frozen-assembly",
          "formal-release",
        ].includes(suggestion.stage))
    )
      gap = {
        status: ownership.status === "blocked" ? "blocked" : "unknown",
        reason: ownership.reason,
        owner: "execution-owner",
        evidence: ownership.evidence,
      };
    else if (source.status !== "passed")
      gap = {
        ...source,
        status: source.status === "failed" ? "blocked" : "unknown",
      };
    else if (["failed", "blocked"].includes(target.status))
      gap = { ...target, status: "blocked" };
    else if (
      ![
        "source-candidate",
        "offline-checks",
        "frozen-assembly",
        "formal-release",
      ].includes(suggestion.stage)
    ) {
      if (frozen.status !== "passed")
        gap = {
          ...frozen,
          status: ["failed", "blocked"].includes(frozen.status)
            ? "blocked"
            : "unknown",
        };
      else if (conflictGap) gap = conflictGap;
      else if (
        suggestion.stage !== "service-structure" &&
        service.status !== "passed"
      )
        gap = {
          ...service,
          status: ["failed", "blocked"].includes(service.status)
            ? "blocked"
            : "unknown",
        };
      else if (problem) gap = runGap(problem);
    }
    return gap
      ? {
          ...base,
          status: gap.status,
          reason: gap.reason,
          owner: gap.owner,
          minimumGap: gap.minimumGap ?? gap.reason,
          evidence: [...base.evidence, ...gap.evidence],
        }
      : base;
  });
  const repairs = list("repairs", "technical-repair").map(
    ({ sourceId, record }) => {
      const d = record?.data;
      const valid =
        d &&
        id(d.issueId) &&
        d.status === "fixed" &&
        sha(d.candidateSha256) &&
        sha(d.candidateContentSha256);
      const matched =
        valid &&
        d.observation !== "historical" &&
        d.candidateSha256 === candidateSha256 &&
        d.candidateContentSha256 === candidateContentSha256 &&
        results.find((v) => v.stage === "source-candidate").status === "passed";
      const history =
        Array.isArray(d?.history) && d.history.length <= 100
          ? d.history
              .filter(
                (v) =>
                  [
                    "failed",
                    "blocked",
                    "not-run",
                    "unknown",
                    "skipped",
                  ].includes(v?.status) &&
                  sha(v.candidateSha256) &&
                  timestamp(v.observedAt) &&
                  Date.parse(v.observedAt) <= Date.parse(d.observedAt),
              )
              .map(({ status, candidateSha256, observedAt }) => ({
                status,
                candidateSha256,
                observedAt,
              }))
          : [];
      return {
        sourceId,
        issueId: valid ? d.issueId : null,
        status: matched ? "fixed" : "unknown",
        relation: !valid
          ? "unavailable"
          : matched
            ? "candidate-matched"
            : "candidate-mismatch",
        history,
        proof: record?.documentCapture
          ? "document-recorded-technical-repair"
          : "recorded-technical-repair",
        ...(record?.documentCapture
          ? {
              context: "not-audited",
              sourceObservedAt: d.provenance.observedAt,
              boundSource: {
                sourceId: record.boundSource.id,
                sha256: record.boundSource.sha256,
              },
            }
          : {}),
        observedAt: record?.data.observedAt ?? null,
        evidence: [...sources(record?.input), ...sources(record?.boundSource)],
      };
    },
  );
  const runtimeGaps = [
    ...(conflictGap ? [conflictGap] : []),
    ...(ownership.status === "matched"
      ? []
      : [
          {
            stage: "execution-ownership",
            reason: ownership.reason,
            status: ownership.status,
            owner: "execution-owner",
            minimumGap: "FORMAL_ACTUAL_BINDING_AND_OCCUPANCY_REQUIRED",
            evidence: ownership.evidence,
          },
        ]),
    ...handoffs
      .filter((v) => v.state === "unknown")
      .map((v) => ({
        stage: "handoff",
        status: "unknown",
        reason: v.reason,
        owner: v.owner,
        minimumGap: v.minimumGap,
        evidence: v.evidence,
      })),
    ...runs
      .filter((v) => !["selected", "historical"].includes(v.relation))
      .map(runGap),
  ];
  return {
    runtime: { ownership, handoffs, tools, runs, current, repairs },
    ...(suggestions ? { suggestions } : {}),
    runtimeGaps,
  };
}
