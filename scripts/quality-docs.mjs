import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verifyExecutionPlan } from "./quality-test-execution.mjs";

export function verifyDocsResults({ directory, expected, receipts }) {
  const results =
    receipts ??
    readdirSync(directory, { recursive: true })
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(resolve(directory, file))));
  const sources = (entries) =>
    entries.map(({ repo, head }) => ({ repo, head })).sort((a, b) => a.repo.localeCompare(b.repo));
  const reject = () => {
    throw Error("QUALITY_DOCS_RECEIPT_REJECTED");
  };
  if (
    !expected?.cores?.length ||
    new Set(expected.cores).size !== expected.cores.length ||
    results.length !== expected.cores.length
  )
    reject();
  for (const core of expected.cores) {
    const matching = results.filter((result) => result.plan?.binding?.manifest?.core === core);
    if (matching.length !== 1) reject();
    const result = matching[0],
      { plan, admission, checks } = result;
    verifyExecutionPlan(plan);
    if (
      result.schemaVersion !== 1 ||
      result.status !== "passed" ||
      result.applicability !== "docs" ||
      result.groupId !== expected.groupId ||
      plan.binding.platform !== "linux" ||
      plan.binding.node !== expected.node ||
      plan.binding.dependencyReview !== false ||
      plan.browser !== false ||
      String(plan.binding.runId) !== String(expected.runId) ||
      String(plan.binding.runAttempt) !== String(expected.runAttempt) ||
      !/^[a-f0-9]{64}$/.test(plan.binding.inputSha256 ?? "") ||
      plan.selected.length ||
      plan.files.length ||
      plan.required.length ||
      plan.shards.length ||
      plan.platformTasks.length ||
      admission?.status !== "passed" ||
      admission.inputSha256 !== plan.binding.inputSha256 ||
      !isDeepStrictEqual(sources(plan.binding.manifest.repositories), sources(expected.sources)) ||
      !isDeepStrictEqual(sources(admission.repositories), sources(expected.sources)) ||
      !admission.repositories.every((entry) => /^[a-f0-9]{64}$/.test(entry.lockSha256 ?? "")) ||
      !Array.isArray(checks) ||
      !isDeepStrictEqual(
        checks.map((check) => check.name),
        ["whitespace", "knowledge"],
      ) ||
      checks.some((check) => check.status !== "passed")
    )
      reject();
  }
  return {
    status: "passed",
    applicability: "docs",
    coverage: "source-admission-and-document-checks",
    sources: expected.sources,
    cores: expected.cores,
    tests: "not-applicable",
    build: "not-applicable",
    macos: "not-applicable",
  };
}
