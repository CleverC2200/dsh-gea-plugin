import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runQualityChecks } from "./run-quality-checks.mjs";
import { sourceCheckBinding, sourceChecks, verifySourceChecks } from "./quality-source-checks.mjs";
const command = "corepack";
const { values, positionals } = parseArgs({
  options: {
    "checks-only": { type: "boolean" },
    "source-only": { type: "boolean" },
    "source-receipt-out": { type: "string" },
    "source-receipt-in": { type: "string" },
    "input-sha256": { type: "string" },
  },
  allowPositionals: true,
});
if (
  (values["source-receipt-out"] && (!values["source-only"] || values["source-receipt-in"])) ||
  (values["source-receipt-in"] && (!values["checks-only"] || values["source-only"])) ||
  ((values["source-receipt-in"] || values["source-receipt-out"]) && positionals.length)
)
  throw Error("QUALITY_SOURCE_RECEIPT_SCOPE_REQUIRED");
const binding =
  values["source-receipt-in"] || values["source-receipt-out"]
    ? sourceCheckBinding({ root: process.cwd(), inputSha256: values["input-sha256"] })
    : undefined;
function check(name) {
  return {
    name,
    execute() {
      const windows = process.platform === "win32";
      const files = ["lint", "format:check"].includes(name) ? positionals : [];
      const child = spawnSync(windows ? command + ".cmd" : command, ["pnpm", name, ...files], {
        stdio: "inherit",
        shell: windows,
      });
      if (child.error || child.signal || child.status !== 0)
        throw Error(child.error?.message ?? child.signal ?? "exit " + child.status);
    },
  };
}
const checks = values["source-receipt-in"]
  ? verifySourceChecks({
      receipt: JSON.parse(readFileSync(values["source-receipt-in"])),
      binding,
    })
  : runQualityChecks(sourceChecks.map(check));
if (values["source-receipt-out"]) {
  const current = sourceCheckBinding({ root: process.cwd(), inputSha256: values["input-sha256"] });
  if (JSON.stringify(current) !== JSON.stringify(binding))
    throw Error("QUALITY_SOURCE_CHANGED_DURING_CHECKS");
  mkdirSync(".runtime", { recursive: true });
  writeFileSync(
    values["source-receipt-out"],
    JSON.stringify(
      {
        schemaVersion: 1,
        binding,
        status: checks.every((entry) => entry.status === "passed") ? "passed" : "failed",
        checks,
      },
      null,
      2,
    ) + "\n",
  );
}
if (!values["source-only"]) {
  const dependent = ["typecheck:official", ...(!values["checks-only"] ? ["test:quality"] : [])];
  checks.push(
    ...(checks.every((entry) => entry.status === "passed")
      ? runQualityChecks(dependent.map(check))
      : dependent.map((name) => ({ name, status: "skipped", reason: "source checks failed" }))),
  );
}
mkdirSync(".runtime", { recursive: true });
writeFileSync(".runtime/quality-fast.json", JSON.stringify(checks, null, 2) + "\n");
console.log(JSON.stringify(checks));
process.exitCode = checks.every((check) => check.status === "passed") ? 0 : 1;
