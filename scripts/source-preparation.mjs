import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { selectPlatformTests } from "./ci-platform-tests.mjs";

export const finalGroupHistoricalCore = "639ed015397290b3745d163aafe02ffee4aa3f84";

export function preparationCoreInputs(plan, platform = process.platform) {
  return plan.joint === true ||
    selectPlatformTests(plan, platform).files.includes("scripts/final-group-input.contract.mjs")
    ? [finalGroupHistoricalCore]
    : [];
}

export function verifyCoreHistory(coreSource, heads) {
  for (const head of heads) {
    try {
      for (const object of [
        head + "^{commit}",
        head + "^{tree}",
        head + ":package.json",
        head + ":pnpm-lock.yaml",
      ])
        execFileSync("git", ["-C", coreSource, "cat-file", "-e", object], {
          stdio: ["ignore", "pipe", "pipe"],
        });
    } catch {
      throw Error(
        "SOURCE_PREPARATION_HISTORY_REQUIRED: " +
          head +
          "; fetch the worker's historical Core inputs before dependency or SDK preparation",
      );
    }
  }
}

export function verifySourcePreparation({
  plan,
  coreSource,
  coreHead,
  platform = process.platform,
}) {
  const actual = execFileSync("git", ["-C", coreSource, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(coreHead ?? "") || actual !== coreHead)
    throw Error("SOURCE_PREPARATION_CORE_MISMATCH");
  const historical = preparationCoreInputs(plan, platform);
  verifyCoreHistory(coreSource, historical);
  return { status: "passed", coreHead, historical, platform, effects: "read-only" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { plan: { type: "string" }, core: { type: "string" }, head: { type: "string" } },
  });
  console.log(
    JSON.stringify(
      verifySourcePreparation({
        plan: JSON.parse(readFileSync(values.plan, "utf8")),
        coreSource: values.core,
        coreHead: values.head,
      }),
    ),
  );
}
