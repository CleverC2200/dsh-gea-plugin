import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = [
  ...readdirSync("tests")
    .filter((name) => /\.(?:test|contract|browser)\.mjs$/.test(name))
    .sort()
    .map((name) => "tests/" + name),
  "scripts/gea-error.test.mjs",
];
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
