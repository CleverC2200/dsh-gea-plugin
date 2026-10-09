import { isObservationTime as time } from "./delivery-time.mjs";
/** Read-only, bounded delivery observations. Never prepares or verifies a runtime. */
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { createReadScope } from "./delivery-input-scope.mjs";
import { observeTaskTicket } from "./delivery-ticket.mjs";
import { pathToFileURL } from "node:url";
import { observeCandidate, observeAssembly } from "./delivery-integrity.mjs";
import { assessReadiness } from "./delivery-readiness.mjs";
import { assessRuntime } from "./delivery-runtime.mjs";
import {
  deriveBudget,
  deriveContinuation,
  reconcileProjections,
  summarizeContinuation,
} from "./delivery-continuation.mjs";

const stages = [
  "source-candidate",
  "offline-checks",
  "frozen-assembly",
  "service-structure",
  "local-authentication",
  "gea-authorization",
  "real-data",
  "model",
  "native-reference",
  "session-recovery",
  "combination-recovery",
  "formal-release",
];
const identifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

async function readInput(scope, ref, observedAt) {
  if (!ref || !identifier(ref.id) || typeof ref.path !== "string")
    return { error: "INVALID_INPUT_REFERENCE" };
  try {
    const bytes = await scope.read(ref.path, 1024 * 1024);
    return { id: ref.id, sha256: digest(bytes), observedAt, bytes };
  } catch (error) {
    return {
      id: ref.id,
      error:
        error.message === "INTEGRITY_MULTILINK_UNVERIFIABLE"
          ? "INPUT_MULTILINK_UNVERIFIABLE"
          : error.message === "INTEGRITY_PERSISTENT_OVERLAP"
            ? "INPUT_PERSISTENT_OVERLAP"
            : error.message === "INTEGRITY_PERSISTENT_SCOPE_UNRESOLVED"
              ? "INPUT_PERSISTENT_SCOPE_UNRESOLVED"
              : error.message === "INTEGRITY_SOURCE_SCOPE_UNSUPPORTED"
                ? "INPUT_SENSITIVE_TARGET"
                : error.message === "INTEGRITY_INPUT_OUTSIDE_ROOT"
                  ? "INPUT_OUTSIDE_ROOT"
                  : error.message === "INTEGRITY_INPUT_UNSUPPORTED"
                    ? "INPUT_NOT_BOUNDED_FILE"
                    : error.code === "ENOENT"
                      ? "INPUT_MISSING"
                      : "INPUT_UNREADABLE",
    };
  }
}
async function observeDirectory(root, ref, observedAt) {
  if (!ref || !identifier(ref.id) || typeof ref.path !== "string")
    return {
      state: "unknown",
      reason: "SESSION_REFERENCE_REQUIRED",
      observedAt,
    };
  try {
    const path = await realpath(resolve(root, ref.path));
    const within = relative(root, path);
    if (within === ".." || within.startsWith("../") || isAbsolute(within))
      return {
        sourceId: ref.id,
        state: "unknown",
        reason: "INPUT_OUTSIDE_ROOT",
        observedAt,
      };
    return {
      sourceId: ref.id,
      state: (await stat(path)).isDirectory() ? "present" : "unknown",
      reason: "DIRECTORY_OBSERVATION_ONLY",
      observedAt,
    };
  } catch (error) {
    return {
      sourceId: ref.id,
      state: error.code === "ENOENT" ? "missing" : "unknown",
      reason:
        error.code === "ENOENT"
          ? "SESSION_DIRECTORY_MISSING"
          : "SESSION_DIRECTORY_UNREADABLE",
      observedAt,
    };
  }
}
function metadata(input) {
  if (input.error) return undefined;
  try {
    return JSON.parse(input.bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}
const evidence = (input) =>
  input.sha256
    ? [
        {
          sourceId: input.id,
          sha256: input.sha256,
          observedAt: input.observedAt,
        },
      ]
    : [];
function stageResult(
  stage,
  status,
  reason,
  sources,
  observedAt,
  owner = "delivery-owner",
  proof = "not-verified",
) {
  return {
    stage,
    status,
    reason,
    owner,
    minimumGap: status === "passed" ? null : reason,
    evidence: sources,
    observedAt,
    proof,
  };
}

/** Input references are root-relative controlled files. Output contains no raw source text or paths. */
export async function checkDelivery(
  input,
  { observedAt = new Date().toISOString() } = {},
) {
  if (
    !identifier(input?.projectId) ||
    !Array.isArray(input.tasks) ||
    input.tasks.length > 100 ||
    !time(observedAt)
  )
    throw Error("INVALID_DELIVERY_REQUEST");
  let root;
  try {
    root = await realpath(input.root);
  } catch {
    throw Error("INPUT_ROOT_UNREADABLE");
  }
  const readScope = await createReadScope(
    root,
    input.tasks.flatMap((task) => [
      ...(task.session ? [task.session] : []),
      ...(Array.isArray(task.persistentRoots)
        ? task.persistentRoots
        : task.persistentRoots
          ? [null]
          : []),
    ]),
  );
  const tasks = [];
  for (const task of input.tasks) {
    if (!identifier(task.id)) throw Error("INVALID_TASK_ID");

    const ticket = await readInput(readScope, task.ticket, observedAt);
    const candidateInput = await readInput(
      readScope,
      task.candidate,
      observedAt,
    );
    const deliveryInput = await readInput(readScope, task.delivery, observedAt);
    const extraInputs = [];
    for (const ref of task.inputs ?? [])
      extraInputs.push(await readInput(readScope, ref, observedAt));
    const inputs = [ticket, candidateInput, deliveryInput, ...extraInputs];
    const candidate = metadata(candidateInput);
    const delivery = metadata(deliveryInput);
    const ticketRecord = observeTaskTicket(ticket, task.id);
    const scopedTicket = ticketRecord.reason === null;
    const status = ticketRecord.status;
    const identifiedCandidate =
      candidate?.taskId === task.id &&
      candidate?.projectId === input.projectId &&
      ["clean", "dirty"].includes(candidate.kind) &&
      typeof candidate.commit === "string" &&
      /^[a-f0-9]{40}$/.test(candidate.commit);
    const fileInputs = [];
    const validFiles =
      identifiedCandidate &&
      (candidate.kind === "clean"
        ? candidate.files === undefined ||
          (Array.isArray(candidate.files) && candidate.files.length === 0)
        : Array.isArray(candidate.files) &&
          candidate.files.length > 0 &&
          candidate.files.length <= 1000 &&
          candidate.files.every(
            (ref) =>
              identifier(ref?.id) &&
              typeof ref.path === "string" &&
              (sha256(ref.sha256) ||
                (candidate.checkout &&
                  ref.deleted === true &&
                  ref.sha256 === undefined)),
          ));
    if (validFiles && candidate.kind === "dirty") {
      for (const ref of candidate.files)
        fileInputs.push(
          ref.deleted === true
            ? { id: ref.id, deleted: true }
            : await readInput(readScope, ref, observedAt),
        );
      inputs.push(...fileInputs);
    }
    const integrity = identifiedCandidate
      ? await observeCandidate(root, candidate, { readScope })
      : null;
    const drift = integrity
      ? integrity.status !== "passed"
      : validFiles &&
        candidate.kind === "dirty" &&
        candidate.files.some(
          (ref, index) => fileInputs[index].sha256 !== ref.sha256,
        );
    const validCandidate = identifiedCandidate && validFiles && !drift;
    let assembly;
    if (task.assembly) {
      const assemblyInput = await readInput(
        readScope,
        task.assembly,
        observedAt,
      );
      inputs.push(assemblyInput);
      assembly = await observeAssembly(root, metadata(assemblyInput), {
        readScope,
        taskId: task.id,
        projectId: input.projectId,
        observedAt,
        candidate,
        integrity,
        candidateSha256: candidateInput.sha256,
      });
      inputs.push(...assembly.inputs);
      assembly.evidence = [...evidence(assemblyInput), ...assembly.evidence];
    }
    const conflictingInputs = inputs.filter(
      (ref, index) =>
        ref.id && inputs.findIndex((other) => other.id === ref.id) !== index,
    );
    const contentSha256 = integrity
      ? integrity.contentSha256
      : identifiedCandidate
        ? digest(
            JSON.stringify({
              snapshot: candidateInput.sha256,
              files: fileInputs.map(({ id, sha256, error }) => ({
                id,
                sha256,
                error,
              })),
            }),
          )
        : null;
    const scopedDelivery =
      delivery?.taskId === task.id && delivery?.projectId === input.projectId;
    const checks =
      scopedDelivery && Array.isArray(delivery.checks) ? delivery.checks : [];
    const records = checks.map((check) => {
      const validCounts =
        check?.counts === undefined ||
        (check.counts &&
          ["passed", "failed", "skipped"].every(
            (key) =>
              Number.isSafeInteger(check.counts[key]) && check.counts[key] >= 0,
          ));
      const valid =
        identifier(check?.id) &&
        check.scope === "offline" &&
        validCounts &&
        !(
          check.status === "passed" &&
          check.counts &&
          (check.counts.failed > 0 ||
            check.counts.skipped > 0 ||
            check.counts.passed === 0)
        ) &&
        time(check.observedAt) &&
        sha256(check.candidateSha256) &&
        (check.candidateContentSha256 === undefined ||
          sha256(check.candidateContentSha256)) &&
        [
          "passed",
          "failed",
          "blocked",
          "not-run",
          "unknown",
          "skipped",
        ].includes(check.status) &&
        Array.isArray(check.inputs) &&
        (check.candidateBinding === undefined ||
          (check.candidateBinding === "inputs-only" &&
            check.inputs.length > 0)) &&
        check.inputs.every(
          (ref) => identifier(ref?.id) && sha256(ref.sha256),
        ) &&
        new Set(check.inputs.map((ref) => ref.id)).size === check.inputs.length;
      const observationGap = !time(check?.observedAt)
        ? "CHECK_OBSERVATION_TIME_INVALID"
        : Date.parse(check.observedAt) > Date.parse(observedAt)
          ? "CHECK_OBSERVATION_IN_FUTURE"
          : null;
      const relation = observationGap
        ? "observation-time-mismatch"
        : !valid
          ? "invalid"
          : check.candidateBinding !== "inputs-only" &&
              check.candidateSha256 !== candidateInput.sha256
            ? "historical"
            : integrity &&
                check.candidateBinding !== "inputs-only" &&
                !check.candidateContentSha256
              ? "candidate-content-binding-required"
              : (drift ||
                    (integrity &&
                      check.candidateContentSha256 !== contentSha256)) &&
                  check.candidateBinding !== "inputs-only"
                ? "candidate-content-mismatch"
                : conflictingInputs.length ||
                    check.inputs.some(
                      (ref) =>
                        !inputs.some(
                          (actual) =>
                            actual.id === ref.id &&
                            actual.sha256 === ref.sha256,
                        ),
                    )
                  ? "input-mismatch"
                  : "current";
      const counts =
        check?.counts &&
        ["passed", "failed", "skipped"].every(
          (key) =>
            Number.isSafeInteger(check.counts[key]) && check.counts[key] >= 0,
        )
          ? Object.fromEntries(
              ["passed", "failed", "skipped"].map((key) => [
                key,
                check.counts[key],
              ]),
            )
          : null;
      return {
        id: identifier(check?.id) ? check.id : "invalid-check",
        scope: "offline",
        status: valid && !observationGap ? check.status : "unknown",
        statedStatus: [
          "passed",
          "failed",
          "blocked",
          "not-run",
          "unknown",
          "skipped",
        ].includes(check?.status)
          ? check.status
          : null,
        observationGap,
        relation,
        candidateSha256: sha256(check?.candidateSha256)
          ? check.candidateSha256
          : null,
        candidateContentSha256: sha256(check?.candidateContentSha256)
          ? check.candidateContentSha256
          : null,
        observedAt: time(check?.observedAt) ? check.observedAt : null,
        owner: "check-owner",
        inputs: valid
          ? check.inputs.map(({ id, sha256 }) => ({ sourceId: id, sha256 }))
          : [],
        counts,
        evidence: evidence(deliveryInput),
      };
    });
    const required =
      scopedDelivery &&
      Array.isArray(delivery.requiredChecks) &&
      delivery.requiredChecks.every(identifier)
        ? [...new Set(delivery.requiredChecks)]
        : [];
    const checkGaps = required.flatMap((id) => {
      const matching = records.filter((record) => record.id === id);
      const current = matching.filter(
        (record) => record.relation === "current",
      );
      if (current.length === 1 && current[0].status === "passed") return [];
      const observationGap = matching.find(
        (record) => record.observationGap,
      )?.observationGap;
      const reason =
        current.length > 1
          ? "CHECK_RECORD_CONFLICT"
          : !matching.length
            ? "CHECK_RECORD_REQUIRED"
            : !current.length
              ? (observationGap ?? "CHECK_INPUT_OR_RECORD_MISMATCH")
              : current[0].status === "failed"
                ? "CHECK_FAILED"
                : ["not-run", "skipped"].includes(current[0].status)
                  ? "CHECK_NOT_RUN"
                  : "CHECK_RESULT_REQUIRED";
      return [
        {
          checkId: id,
          reason,
          owner: "check-owner",
          minimumGap:
            reason === observationGap
              ? "VALID_CHECK_OBSERVATION_AT_OR_BEFORE_REPORT_REQUIRED"
              : "MATCHING_CHECK_RESULT_REQUIRED",
          evidence: evidence(deliveryInput),
        },
      ];
    });
    let offlineStatus = "unknown",
      offlineReason = "SCOPED_CHECKS_REQUIRED";
    if (
      scopedTicket &&
      validCandidate &&
      !conflictingInputs.length &&
      required.length
    ) {
      const selected = required.map((id) =>
        records.filter(
          (check) => check.id === id && check.relation === "current",
        ),
      );
      if (
        selected.some((checks) =>
          checks.some((check) => check.status === "failed"),
        )
      ) {
        offlineStatus = "failed";
        offlineReason = "SCOPED_CHECK_FAILED";
      } else if (selected.some((checks) => checks.length > 1))
        offlineReason = "CHECK_RECORD_CONFLICT";
      else if (
        selected.every(
          (checks) =>
            checks.length === 1 &&
            checks[0].status === "passed" &&
            (!checks[0].counts || checks[0].counts.failed === 0),
        )
      ) {
        offlineStatus = "passed";
        offlineReason = "SCOPED_CHECKS_REUSED";
      } else if (
        selected.some((checks) =>
          checks.some((check) => check.status === "blocked"),
        )
      ) {
        offlineStatus = "blocked";
        offlineReason = "SCOPED_CHECK_BLOCKED";
      } else if (
        selected.every(
          (checks) =>
            checks.length === 1 &&
            ["skipped", "not-run"].includes(checks[0].status),
        )
      ) {
        offlineStatus = "not-run";
        offlineReason = "SCOPED_CHECK_NOT_RUN";
      }
    }
    if (offlineStatus === "unknown" && deliveryInput.error)
      offlineReason = deliveryInput.error;
    if (offlineStatus === "unknown") {
      const observationGap = checkGaps.find((gap) =>
        gap.reason.startsWith("CHECK_OBSERVATION"),
      );
      if (observationGap) offlineReason = observationGap.reason;
    }
    const results = stages.map((stage) =>
      stageResult(stage, "not-run", "STAGE_NOT_CHECKED", [], observedAt),
    );
    results[0] = stageResult(
      "source-candidate",
      integrity
        ? validFiles
          ? integrity.status
          : "unknown"
        : drift
          ? "failed"
          : validCandidate
            ? "passed"
            : "unknown",
      integrity
        ? validFiles
          ? integrity.reason
          : "CANDIDATE_RECORD_REQUIRED"
        : drift
          ? "CANDIDATE_CONTENT_CHANGED"
          : validCandidate
            ? "CANDIDATE_RECORD_IDENTIFIED"
            : (candidateInput.error ?? "CANDIDATE_RECORD_REQUIRED"),
      [...evidence(candidateInput), ...fileInputs.flatMap(evidence)],
      observedAt,
      "candidate-owner",
      integrity?.proof ?? "recorded-snapshot",
    );
    const ticketGap =
      ticketRecord.reason ??
      (conflictingInputs.length ? "INPUT_ID_CONFLICT" : null);
    if (ticketGap)
      Object.assign(results[0], {
        status: "unknown",
        reason: ticketGap,
        minimumGap: "MATCHING_UNIQUE_TASK_TICKET_REQUIRED",
        proof: "not-verified",
        evidence: [...evidence(ticket), ...results[0].evidence],
      });
    results[1] = stageResult(
      "offline-checks",
      offlineStatus,
      offlineReason,
      evidence(deliveryInput),
      observedAt,
      "check-owner",
      offlineStatus === "passed" ? "recorded-reused" : "recorded-observation",
    );
    if (offlineReason.startsWith("CHECK_OBSERVATION"))
      results[1].minimumGap =
        "VALID_CHECK_OBSERVATION_AT_OR_BEFORE_REPORT_REQUIRED";
    if (assembly) {
      if (!scopedTicket || conflictingInputs.length)
        assembly = {
          ...assembly,
          status: "unknown",
          reason: "ASSEMBLY_SOURCE_CONFLICT",
          minimumGap: "MATCHING_UNIQUE_SCOPED_ASSEMBLY_INPUTS_REQUIRED",
          proof: "not-verified",
        };
      results[2] = {
        ...stageResult(
          "frozen-assembly",
          assembly.status,
          assembly.reason,
          assembly.evidence,
          observedAt,
          "assembly-owner",
          assembly.proof,
        ),
        minimumGap: assembly.minimumGap,
      };
    }
    const session = await observeDirectory(root, task.session, observedAt);
    if (task.session)
      results[9] = stageResult(
        "session-recovery",
        session.state === "missing"
          ? "blocked"
          : session.state === "present"
            ? "not-run"
            : "unknown",
        session.state === "present"
          ? "SESSION_RECOVERY_NOT_RUN"
          : session.reason,
        session.sourceId ? [{ sourceId: session.sourceId, observedAt }] : [],
        observedAt,
        "session-owner",
      );
    for (const entry of scopedDelivery && Array.isArray(delivery.notApplicable)
      ? delivery.notApplicable
      : []) {
      const index = stages.indexOf(entry?.stage);
      // Source and offline proof cannot be waived through report metadata.
      if (index < 2) continue;
      if (index === 2 && task.assembly) {
        results[index] = stageResult(
          "frozen-assembly",
          "unknown",
          "ASSEMBLY_APPLICABILITY_CONFLICT",
          evidence(deliveryInput),
          observedAt,
          "assembly-owner",
        );
        continue;
      }
      const sources = inputs.filter((ref) => ref.id === entry.sourceId);
      const source =
        sources.length === 1 && sources[0].sha256 ? sources[0] : undefined;
      const sameStage = delivery.notApplicable.filter(
        (ref) => ref?.stage === entry.stage,
      );
      results[index] =
        source &&
        entry.reasonCode === "outside-task-scope" &&
        sameStage.length === 1
          ? stageResult(
              entry.stage,
              "not-applicable",
              "OUTSIDE_TASK_SCOPE",
              [...evidence(deliveryInput), ...evidence(source)],
              observedAt,
              "delivery-owner",
              "recorded-applicability",
            )
          : stageResult(
              entry.stage,
              "unknown",
              "APPLICABILITY_REASON_REQUIRED",
              evidence(deliveryInput),
              observedAt,
            );
    }
    const readiness = assessReadiness({
      inputs,
      ticket,
      taskId: task.id,
      projectId: input.projectId,
      stages,
      observedAt,
      candidateSha256: candidateInput.sha256,
      candidateContentSha256: contentSha256,
      candidateValid:
        scopedTicket && validCandidate && !conflictingInputs.length,
    });
    if (readiness) {
      for (const suggestion of readiness.suggestions) {
        const result = results.find(
          (result) => result.stage === suggestion.stage,
        );
        if (
          suggestion.status === "blocked" &&
          ["not-run", "unknown"].includes(result.status)
        )
          Object.assign(
            result,
            stageResult(
              result.stage,
              "blocked",
              suggestion.reason,
              suggestion.evidence,
              observedAt,
              suggestion.owner,
            ),
          );
      }
      for (const gap of [
        ...readiness.configGaps,
        ...readiness.policyGaps,
        ...readiness.factGaps,
      ]) {
        const result = results.find((result) => result.stage === gap.stage);
        if (["not-run", "unknown", "blocked"].includes(result.status))
          Object.assign(
            result,
            stageResult(
              result.stage,
              gap.status,
              gap.reason,
              gap.evidence,
              observedAt,
              gap.owner,
              "recorded-readiness-observation",
            ),
          );
      }
    }
    const runtime = await assessRuntime({
      inputs,
      task,
      projectId: input.projectId,
      observedAt,
      candidate,
      readScope,
      results,
      assembly,
      candidateSha256: candidateInput.sha256,
      candidateContentSha256: contentSha256,
      readiness,
      taskValid: scopedTicket && !conflictingInputs.length,
    });
    const budget = deriveBudget({
      delivery,
      inputs,
      observedAt,
      scoped: scopedTicket && scopedDelivery && !conflictingInputs.length,
    });
    const reconciliation = reconcileProjections({
      delivery,
      inputs,
      observedAt,
      scoped: scopedTicket && scopedDelivery && !conflictingInputs.length,
    });
    const taskReport = {
      taskId: task.id,
      executionStatus: status,
      candidate: identifiedCandidate
        ? {
            kind: candidate.kind,
            commit: candidate.commit,
            sha256: candidateInput.sha256,
            contentSha256,
            proof: integrity?.proof ?? "recorded-snapshot",
            ...(integrity ? { integrity } : {}),
          }
        : null,
      inputs: inputs.map(({ bytes, ...safe }) => safe),
      checks: records,
      requiredChecks: required,
      checkGaps,
      session,
      ...(assembly
        ? {
            assembly: Object.fromEntries(
              Object.entries(assembly).filter(([key]) => key !== "inputs"),
            ),
          }
        : {}),
      ...(readiness ?? {}),
      ...(runtime ?? {}),
      ...(budget ? { budget } : {}),
      ...(reconciliation ? { reconciliation } : {}),
      stages: results,
      diagnostics: [
        ...(budget && budget.status !== "observed"
          ? [
              {
                stage: "budget",
                reason: budget.reason,
                owner: "delivery-owner",
                minimumGap: budget.minimumGap,
                evidence: budget.evidence,
              },
            ]
          : []),
        ...(reconciliation?.conflicts.map((conflict) => ({
          stage: "projection",
          owner: "delivery-owner",
          ...conflict,
        })) ?? []),
        ...(runtime?.runtimeGaps ?? []),
        ...(conflictingInputs.length
          ? [
              {
                stage: "input-record",
                reason: "INPUT_ID_CONFLICT",
                owner: "delivery-owner",
                minimumGap: "UNIQUE_SOURCE_IDS_REQUIRED",
                evidence: inputs
                  .filter((ref) =>
                    conflictingInputs.some(
                      (conflict) => conflict.id === ref.id,
                    ),
                  )
                  .flatMap(evidence),
              },
            ]
          : []),
        ...(!scopedTicket
          ? [
              {
                stage: "task-record",
                reason: ticketRecord.reason,
                owner: "delivery-owner",
                minimumGap: "MATCHING_TASK_TICKET_REQUIRED",
                evidence: evidence(ticket),
              },
            ]
          : []),
        ...results
          .filter((s) => !["passed", "not-applicable"].includes(s.status))
          .map(({ stage, reason, owner, minimumGap, evidence }) => ({
            stage,
            reason,
            owner,
            minimumGap,
            evidence,
          })),
      ],
    };
    const sourceGap = results[0].status !== "passed" ? results[0] : null;
    const consistencyGap =
      reconciliation && reconciliation.status !== "observed"
        ? reconciliation
        : budget && budget.status !== "observed"
          ? budget
          : (sourceGap ??
            (ticketGap
              ? {
                  status: "unknown",
                  reason: ticketGap,
                  minimumGap: "MATCHING_UNIQUE_TASK_TICKET_REQUIRED",
                }
              : null));
    taskReport.consistency = {
      status: consistencyGap?.status ?? "observed",
      reason: consistencyGap?.reason ?? "SAME_READ_DERIVATION",
      minimumGap: consistencyGap?.minimumGap ?? null,
      observedAt,
      acceptance: "not-evaluated",
    };
    if (consistencyGap && taskReport.suggestions)
      taskReport.suggestions = taskReport.suggestions.map((suggestion) =>
        suggestion.status === "can-continue"
          ? {
              ...suggestion,
              status:
                consistencyGap.status === "failed" ? "blocked" : "unknown",
              reason: consistencyGap.reason,
              minimumGap: consistencyGap.minimumGap,
            }
          : suggestion,
      );
    taskReport.continuation = deriveContinuation({
      delivery,
      task: taskReport,
      inputs,
      observedAt,
      scoped: scopedTicket && scopedDelivery && !conflictingInputs.length,
    });
    tasks.push(taskReport);
  }
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    observedAt,
    observation: "offline-readonly",
    consistency: {
      status: tasks.some((task) => task.consistency.status === "failed")
        ? "failed"
        : tasks.some((task) => task.consistency.status === "unknown")
          ? "unknown"
          : "observed",
      generated: true,
      acceptance: "not-evaluated",
      exitZeroMeans: "report-generated-only",
    },
    continuation: summarizeContinuation(tasks, observedAt),
    tasks,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    const verifyGoal = args[0] === "--verify-goal";
    const verify = verifyGoal || args[0] === "--verify";
    if (verify) args.shift();
    const short = args.length === 3 && args[2] === "--continuation";
    if ((!short && args.length !== 2) || args[0] !== "--input")
      throw Error("CLI_INPUT_REQUIRED");
    const file = args[1];
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw Error("CLI_INPUT_INVALID");
    let request;
    try {
      request = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw Error("DELIVERY_REQUEST_INVALID_JSON");
      throw error;
    }
    const report = await checkDelivery(request);
    if (verify) {
      const passed =
        report.tasks.length > 0 && report.consistency.status === "observed";
      report.verification = {
        status: passed ? "passed" : "failed",
        reason: passed
          ? "DELIVERY_CONSISTENCY_OBSERVED"
          : "DELIVERY_CONSISTENCY_REQUIRED",
        minimumGap: passed
          ? null
          : "RECONCILE_FIXED_RECEIPTS_USING_DELIVERY_REPORT",
      };
      report.consistency.exitZeroMeans = "consistency-observed-only";
      if (!passed) process.exitCode = 3;
      if (verifyGoal) {
        report.consistency.exitZeroMeans = "declared-goal-verified-only";
        if (passed) {
          const complete =
            report.continuation.state === "completed" &&
            report.tasks.every(
              (task) => task.continuation.inTransit.length === 0,
            );
          report.verification = {
            status: complete ? "passed" : "failed",
            reason: complete
              ? "DECLARED_GOAL_VERIFIED"
              : "DECLARED_GOAL_INCOMPLETE",
            minimumGap: complete
              ? null
              : "READ_CONTINUATION_REMAINING_AND_STOP_CONDITIONS",
          };
          if (!complete) process.exitCode = 4;
        }
      }
    }
    console.log(
      JSON.stringify(
        short
          ? {
              ...report,
              tasks: report.tasks.map((task) => ({
                taskId: task.taskId,
                ...task.continuation,
                ...(task.budget ? { budget: task.budget } : {}),
                ...(task.reconciliation
                  ? { reconciliation: task.reconciliation }
                  : {}),
              })),
            }
          : report,
        null,
        2,
      ),
    );
  } catch (error) {
    const codes = new Set([
      "CLI_INPUT_REQUIRED",
      "CLI_INPUT_INVALID",
      "INVALID_DELIVERY_REQUEST",
      "INVALID_TASK_ID",
      "INPUT_ROOT_UNREADABLE",
      "DELIVERY_REQUEST_INVALID_JSON",
    ]);
    const reason = codes.has(error.message)
      ? error.message
      : error.code === "ENOENT"
        ? "DELIVERY_REQUEST_MISSING"
        : "DELIVERY_INPUT_UNAVAILABLE";
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        status: "unknown",
        reason,
      }),
    );
    process.exitCode = 2;
  }
}
