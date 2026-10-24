/** Job-local receipts for the public quality CLI's process-independent stages. */
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  appendFileSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { clientEntry } from "./source-combination-integrity.mjs";

// Manage's fixed tsdown build declares one CJS client entry, sourcemap, injected CSS and no DTS.
// Source/lock admission fixes that build configuration; all three consumers use this exact output set.
const buildOutputs = [
  { path: "candidate/dsh-gea-plugin/lib" },
  { path: "candidate/dsh-agent-manage/lib" },
  { path: "candidate/dsh-agent-manage/client", files: ["client.js", "client.js.map"] },
];
const sourceOnlyWorkbenchOutput = { path: "candidate/dsh-agent-workbench/lib" };
export function isQualityBuildOutput(file) {
  return [...buildOutputs, sourceOnlyWorkbenchOutput].some(({ path, files }) =>
    files ? files.some((name) => file === path + "/" + name) : file.startsWith(path + "/"),
  );
}
export function qualityBuildOutputs(root) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "candidate/dsh-agent-manage/package.json")),
  );
  if (manifest.name !== "dsh-agent-manage" || clientEntry(manifest) !== "./client/client.js")
    throw Error("QUALITY_STAGE_CLIENT_DECLARATION_CHANGED");
  const plan = JSON.parse(readFileSync(resolve(root, "quality-test-plan.json")));
  return [...buildOutputs, ...(plan.runtime ? [] : [sourceOnlyWorkbenchOutput])].map(
    ({ path, ...entry }) => ({ root: resolve(root, path), ...entry }),
  );
}
export function verifyQualityBuildInventory(root, artifacts) {
  const outputs = qualityBuildOutputs(root);
  if (
    JSON.stringify(Object.keys(artifacts ?? {}).sort()) !==
    JSON.stringify(outputs.map((x) => x.root).sort())
  )
    throw Error("QUALITY_STAGE_ARTIFACT_REQUIRED: exact build inventory roots");
  for (const output of outputs)
    if (
      output.files &&
      (JSON.stringify(Object.keys(artifacts[output.root] ?? {}).sort()) !==
        JSON.stringify(output.files) ||
        JSON.stringify(readdirSync(output.root).sort()) !== JSON.stringify(output.files))
    )
      throw Error("QUALITY_STAGE_ARTIFACT_REQUIRED: exact Manage client outputs");
  return outputs;
}

export const qualityStages = ["prepare", "build", "checks", "tests"];
export function observeQualityStages(file) {
  const unknown = {
    status: "unknown",
    lastConfirmedStage: null,
    lastConfirmedAt: null,
    testsStarted: null,
  };
  let observed = unknown;
  try {
    const record = JSON.parse(readFileSync(file));
    if (record.schemaVersion !== 1 || !record.stages) throw Error("stage evidence missing");
    const name = qualityStages.findLast((stage) => record.stages[stage]);
    const stage = record.stages[name];
    if (!stage || !["running", "passed", "failed"].includes(stage.status))
      throw Error("stage evidence missing");
    const step = stage.steps?.at(-1);
    const at = stage.finishedAt ?? step?.finishedAt ?? step?.startedAt ?? stage.startedAt;
    if (!Number.isFinite(Date.parse(at))) throw Error("stage time missing");
    observed = {
      status: "observed",
      source: file,
      lastConfirmedStage: name,
      lastConfirmedAt: at,
      stageStatus: stage.status,
      ...(step
        ? { lastConfirmedStep: step.name, stepStatus: step.status, budgetMs: step.budgetMs }
        : {}),
      testsStarted: Boolean(record.stages.tests?.startedAt),
    };
  } catch (error) {
    observed = { ...unknown, reason: error.message };
  }
  const workerFile = resolve(file, "../quality-worker-inputs.json");
  if (existsSync(workerFile)) {
    try {
      const worker = JSON.parse(readFileSync(workerFile));
      if (
        worker.schemaVersion !== 1 ||
        !["running", "failed", "worker-inputs-ready"].includes(worker.status) ||
        !Array.isArray(worker.steps)
      )
        throw Error("worker stage evidence missing");
      const step = worker.steps.at(-1);
      const at = worker.finishedAt ?? step?.finishedAt ?? step?.startedAt ?? worker.startedAt;
      if (!Number.isFinite(Date.parse(at))) throw Error("worker stage time missing");
      if (observed.status === "unknown" || Date.parse(at) > Date.parse(observed.lastConfirmedAt))
        observed = {
          status: "observed",
          source: workerFile,
          lastConfirmedStage: "prepare",
          lastConfirmedAt: at,
          stageStatus: worker.status === "worker-inputs-ready" ? "passed" : worker.status,
          ...(step
            ? { lastConfirmedStep: step.name, stepStatus: step.status, budgetMs: step.budgetMs }
            : {}),
          testsStarted: false,
        };
    } catch (error) {
      return { ...unknown, reason: error.message };
    }
  }
  return observed;
}
export function qualityStageRun({ file, binding, requested }) {
  const persist = () => {
    writeFileSync(file + ".tmp", JSON.stringify(record, null, 2) + "\n");
    renameSync(file + ".tmp", file);
  };
  let record;
  if (requested === "full" || (["prepare", "summary"].includes(requested) && !existsSync(file))) {
    record = {
      schemaVersion: 1,
      binding,
      startedAt: new Date().toISOString(),
      stages: {},
      checks: [],
    };
  } else {
    if (!existsSync(file)) throw Error("QUALITY_STAGE_MISSING: prepare");
    record = JSON.parse(readFileSync(file));
    if (record.schemaVersion !== 1 || JSON.stringify(record.binding) !== JSON.stringify(binding))
      throw Error("QUALITY_STAGE_INPUT_CHANGED");
  }
  let current;
  const finish = (error) => {
    if (!current) {
      if (error) {
        record.status = "failed";
        record.error = error.message;
        persist();
      }
      return;
    }
    const stage = record.stages[current];
    stage.finishedAt = new Date().toISOString();
    stage.durationMs = Date.parse(stage.finishedAt) - Date.parse(stage.startedAt);
    stage.status = error ? "failed" : "passed";
    if (error) stage.error = error.message;
    console.log(JSON.stringify({ stage: current, ...stage }));
    current = undefined;
    persist();
  };
  return {
    record,
    start(name) {
      if (record.stages[name]) throw Error("QUALITY_STAGE_ALREADY_RECORDED: " + name);
      const dependencies =
        name === "prepare" ? [] : name === "build" ? ["prepare"] : ["prepare", "build"];
      for (const dependency of dependencies)
        if (record.stages[dependency]?.status !== "passed")
          throw Error("QUALITY_STAGE_DEPENDENCY: " + dependency);
      if (name === "tests" && record.stages.checks?.status !== "passed")
        throw Error("QUALITY_STAGE_DEPENDENCY: checks");
      current = name;
      record.stages[name] = { status: "running", startedAt: new Date().toISOString() };
      persist();
      console.log(JSON.stringify({ stage: name, ...record.stages[name] }));
    },
    finish,
    async step(name, metadata, execute) {
      if (!current) throw Error("QUALITY_STAGE_REQUIRED: browser step");
      const parent = current;
      const step = { name, ...metadata, status: "running", startedAt: new Date().toISOString() };
      (record.stages[parent].steps ??= []).push(step);
      persist();
      console.log(
        JSON.stringify({
          stage: parent,
          step: name,
          testsStarted: Boolean(record.stages.tests),
          ...step,
        }),
      );
      try {
        const result = await execute();
        step.status = "passed";
        return result;
      } catch (error) {
        step.status = "failed";
        step.error = error.message;
        throw error;
      } finally {
        step.finishedAt = new Date().toISOString();
        step.durationMs = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
        persist();
        console.log(
          JSON.stringify({
            stage: parent,
            step: name,
            testsStarted: Boolean(record.stages.tests),
            ...step,
          }),
        );
      }
    },
    summarize({ workflowResults = false } = {}) {
      const results = qualityStages.map((name) => ({ name, ...record.stages[name] }));
      const failed =
        results.some(
          (stage) =>
            stage.status !== "passed" ||
            !Number.isFinite(Date.parse(stage.startedAt)) ||
            !Number.isFinite(Date.parse(stage.finishedAt)) ||
            stage.durationMs !== Date.parse(stage.finishedAt) - Date.parse(stage.startedAt) ||
            stage.durationMs < 0,
        ) ||
        JSON.stringify(record.checks.map((check) => check.name)) !==
          JSON.stringify(["final-group", "fast", "required-and-affected"]) ||
        record.checks.some((check) => check.status !== "passed") ||
        (workflowResults &&
          qualityStages.some(
            (name) => process.env[`QUALITY_STAGE_${name.toUpperCase()}_RESULT`] !== "success",
          ));
      record.status = failed ? "failed" : "passed";
      record.finishedAt = new Date().toISOString();
      record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
      persist();
      writeFileSync(
        resolve(file, "../quality-checks.json"),
        JSON.stringify(record.checks, null, 2) + "\n",
      );
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          [
            "## Quality stages",
            "",
            `Result: ${record.status}. Completed-stage summary; times are measured by the CLI.`,
            "",
            "| Stage | Status | Started | Finished | Duration (ms) |",
            "| --- | --- | --- | --- | --- |",
            ...results.map(
              (stage) =>
                `| ${stage.name} | ${stage.status ?? "missing"} | ${stage.startedAt ?? ""} | ${stage.finishedAt ?? ""} | ${stage.durationMs ?? ""} |`,
            ),
            "",
          ].join("\n"),
        );
      console.log(JSON.stringify(record));
      if (failed) throw Error("QUALITY_STAGES_FAILED");
    },
  };
}
