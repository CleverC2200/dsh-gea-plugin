/** Job-local receipts for the public quality CLI's process-independent stages. */
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

export const qualityStages = ["prepare", "build", "checks", "tests"];
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
      if (name === "tests" && !["passed", "failed"].includes(record.stages.checks?.status))
        throw Error("QUALITY_STAGE_DEPENDENCY: checks");
      current = name;
      record.stages[name] = { status: "running", startedAt: new Date().toISOString() };
      persist();
      console.log(JSON.stringify({ stage: name, ...record.stages[name] }));
    },
    finish,
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
