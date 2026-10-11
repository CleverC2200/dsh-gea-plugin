import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { readProfileSources } from "./profile-inputs.mjs";

/** Execute the frozen presentation owner's assertions in its own dependency/build layout. */
export async function runWorkbenchContracts(files) {
  const sources = await readProfileSources(process.env.GEA_TEST_SOURCE_INPUTS);
  const owner = sources.find((entry) => entry.repo === "dsh-agent-workbench");
  const cwd = dirname(owner.dependencies);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
    owner.commit,
  );
  execFileSync("git", ["diff", "--exit-code", "HEAD", "--", ...files], { cwd });
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", "--test-reporter=tap", ...files],
    {
      cwd,
      encoding: "utf8",
      env: process.env,
    },
  );
  const report = result.stdout + result.stderr;
  assert.equal(result.status, 0, report);
  const count = (label) => Number(report.match(new RegExp(`^# ${label} (\\d+)$`, "m"))?.[1] ?? NaN);
  assert.ok(count("tests") > 0, report);
  assert.equal(count("pass"), count("tests"), report);
  for (const label of ["fail", "cancelled", "skipped", "todo"])
    assert.equal(count(label), 0, report);
  return { commit: owner.commit, cwd, files, tests: count("tests") };
}
