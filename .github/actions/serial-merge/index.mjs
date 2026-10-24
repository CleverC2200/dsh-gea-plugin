import { DefaultArtifactClient } from "@actions/artifact";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createSerialMergeArtifacts } from "../../../scripts/serial-merge-artifacts.mjs";
import { createSerialMergeRuntime } from "../../../scripts/serial-merge-runtime.mjs";
import { executeSerialMerge } from "../../../scripts/serial-merge-runner.mjs";

const cancellation = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => cancellation.abort());
try {
  if (process.env.GITHUB_ACTIONS !== "true") throw Error("github_actions_required");
  const context = {
    controllerWorkflowId: Number(process.env.GEA_MERGE_WORKFLOW_ID),
    runId: Number(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    actor: process.env.GITHUB_ACTOR,
    actorId: Number(process.env.GITHUB_ACTOR_ID),
    ref: process.env.GITHUB_REF,
    enabled: process.env.GEA_MERGE_ENABLED === "true",
    checkoutSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    appId: Number(process.env.GEA_MERGE_APP_ID),
    installationId: Number(process.env.GEA_MERGE_INSTALLATION_ID),
    rulesetId: Number(process.env.GEA_MERGE_RULESET_ID),
  };
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const runtime = createSerialMergeRuntime({
    context,
    event,
    privateKey: process.env["INPUT_APP-PRIVATE-KEY"],
    githubToken: process.env["INPUT_GITHUB-TOKEN"],
    signal: cancellation.signal,
    mask: (value) =>
      process.stdout.write(
        "::add-mask::" +
          value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A") +
          "\n",
      ),
    journalFactory: (options) =>
      createSerialMergeArtifacts({
        ...options,
        artifact: new DefaultArtifactClient(),
        directory: resolve(process.env.RUNNER_TEMP, "gea-serial-merge"),
        retentionDays: options.policy.retentionDays,
      }),
  });
  const result = await executeSerialMerge(
    {
      operation: event.inputs?.operation,
      pr: event.inputs?.pr,
      head: event.inputs?.head,
      recoveryRequestId: event.inputs?.recovery_request_id,
    },
    runtime,
  );
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.status !== "finished" || !["merged", "already_finished"].includes(result.reason))
    process.exitCode = 1;
} catch {
  process.stderr.write(
    "GEA_SERIAL_MERGE_FAILED: inspect durable request state; credentials and API bodies omitted\n",
  );
  process.exitCode = 1;
}
