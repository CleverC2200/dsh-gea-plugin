/** CI's full phase retains every full-suite file without repeating contract files. */
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
const contractFiles = new Set(
  scripts["test:contracts"].match(/\b(?:tests|scripts)\/[\w.-]+\.test\.mjs\b/g) ?? [],
);
const files = [
  ...readdirSync("tests")
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => "tests/" + name),
  "scripts/gea-error.test.mjs",
].filter((file) => !contractFiles.has(file));
if (process.argv.includes("--list")) console.log(JSON.stringify(files));
else {
  const child = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=./scripts/quality-test-reporter.mjs",
      ...files,
    ],
    { stdio: "inherit" },
  );
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
