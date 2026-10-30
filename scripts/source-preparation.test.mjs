import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  preparationCoreInputs,
  verifyCoreHistory,
  verifySourcePreparation,
  finalGroupHistoricalCore,
} from "./source-preparation.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "source-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Core preparation fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git("add", ".");
  git("commit", "-qm", "historical input");
  const historical = git("rev-parse", "HEAD");
  writeFileSync(join(root, "package.json"), '{"name":"current"}\n');
  git("commit", "-qam", "current input");
  return { root, git, historical, head: git("rev-parse", "HEAD") };
}

test("historical Core requirements follow the selected consumer without burdening current-only preparation", () => {
  assert.deepEqual(
    preparationCoreInputs({ files: ["scripts/final-group-input.contract.mjs"] }, "linux"),
    [finalGroupHistoricalCore],
  );
  assert.deepEqual(preparationCoreInputs({ files: ["tests/auth.test.mjs"] }, "linux"), []);
  assert.deepEqual(
    preparationCoreInputs({ joint: true, files: ["tests/auth.test.mjs"] }, "linux"),
    [finalGroupHistoricalCore],
  );
});

test("real shallow Git preserves current preparation but refuses historical consumers without mutation", (t) => {
  const f = fixture(t);
  const shallow = join(f.root, "shallow");
  execFileSync("git", ["clone", "--quiet", "--depth=1", pathToFileURL(f.root).href, shallow]);
  verifyCoreHistory(f.root, [f.historical]);
  assert.throws(
    () => verifyCoreHistory(shallow, [f.historical]),
    /SOURCE_PREPARATION_HISTORY_REQUIRED/,
  );
  const before = execFileSync("git", ["-C", shallow, "status", "--porcelain"], {
    encoding: "utf8",
  });
  assert.equal(
    verifySourcePreparation({
      plan: { files: ["tests/auth.test.mjs"] },
      coreSource: shallow,
      coreHead: f.head,
    }).status,
    "passed",
  );
  assert.throws(
    () =>
      verifySourcePreparation({
        plan: { joint: true, files: ["tests/auth.test.mjs"] },
        coreSource: shallow,
        coreHead: f.head,
      }),
    /SOURCE_PREPARATION_HISTORY_REQUIRED/,
  );
  assert.throws(
    () =>
      verifySourcePreparation({ plan: { files: [] }, coreSource: shallow, coreHead: f.historical }),
    /SOURCE_PREPARATION_CORE_MISMATCH/,
  );
  assert.equal(
    execFileSync("git", ["-C", shallow, "status", "--porcelain"], { encoding: "utf8" }),
    before,
  );
});

test("history with missing preparation metadata is rejected even when its commit exists", (t) => {
  const f = fixture(t);
  f.git("rm", "pnpm-lock.yaml");
  f.git("commit", "-qm", "missing lock");
  assert.throws(
    () => verifyCoreHistory(f.root, [f.git("rev-parse", "HEAD")]),
    /SOURCE_PREPARATION_HISTORY_REQUIRED/,
  );
});

test("source workflow keeps historical checks before dependency preparation and SDK builds", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/source-quality.yml", import.meta.url),
    "utf8",
  );
  const worker = workflow.split("  source-checks:\n")[1].split("\n  dependency-review:")[0];
  const preflight = worker.indexOf("node scripts/source-preparation.mjs --plan");
  assert.ok(preflight > worker.indexOf("path: source/official-core"));
  for (const later of [
    "Restore policies into",
    "Enable declared package managers",
    "Prepare owned Core",
    "Prepare or verify SDK",
  ])
    assert.ok(preflight < worker.indexOf(later), later);
  assert.match(worker.slice(0, preflight).split("path: source/official-core")[1], /fetch-depth: 0/);
  const producer = workflow.split("  dependency-policy:\n")[1].split("\n  source-checks:")[0];
  assert.match(producer, /path: preparation\/official-core\n          fetch-depth: 1/);
  assert.doesNotMatch(producer, /source-preparation\.mjs/);
  assert.match(
    workflow.split("  dependency-policy:\n")[0],
    /scripts\/source-preparation\.test\.mjs/,
  );
});
