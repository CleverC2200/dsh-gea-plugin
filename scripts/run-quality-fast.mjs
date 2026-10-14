import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runQualityChecks } from "./run-quality-checks.mjs";
const command = "corepack";
const { values } = parseArgs({ options: { "checks-only": { type: "boolean" } } });
const checks = runQualityChecks(
  [
    "lint",
    "format:check",
    "typecheck:official",
    "check:knowledge",
    ...(!values["checks-only"] ? ["test:quality"] : []),
    "check:prompt-execution",
  ].map((name) => ({
    name,
    execute() {
      const windows = process.platform === "win32";
      const child = spawnSync(windows ? command + ".cmd" : command, ["pnpm", name], {
        stdio: "inherit",
        shell: windows,
      });
      if (child.error || child.signal || child.status !== 0)
        throw Error(child.error?.message ?? child.signal ?? "exit " + child.status);
    },
  })),
);
mkdirSync(".runtime", { recursive: true });
writeFileSync(".runtime/quality-fast.json", JSON.stringify(checks, null, 2) + "\n");
console.log(JSON.stringify(checks));
process.exitCode = checks.every((check) => check.status === "passed") ? 0 : 1;
