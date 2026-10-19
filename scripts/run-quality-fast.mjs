import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runQualityChecks } from "./run-quality-checks.mjs";
const command = "corepack";
const { values, positionals } = parseArgs({
  options: { "checks-only": { type: "boolean" }, "source-only": { type: "boolean" } },
  allowPositionals: true,
});
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
const checks = runQualityChecks(
  [
    "lint",
    "format:check",
    "check:knowledge",
    "check:prompt-execution",
    "test:environment",
    "test:release-contract",
  ].map(check),
);
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
