import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
test("the public prepared Workbench verifier refuses an absent frozen receipt", () => {
  const result = spawnSync(process.execPath, ["scripts/quality-workbench.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALITY_WORKBENCH_RECEIPT_REQUIRED/);
});

test("prepared outputs cannot conceal a dirty source checkout or a changed non-output blob", () => {
  const root = mkdtempSync(join(tmpdir(), "gea-workbench-source-"));
  try {
    const source = join(root, "source"),
      prepared = join(root, "prepared");
    mkdirSync(source);
    writeFileSync(join(source, "package.json"), "{}");
    const git = (...args) =>
      execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("-C", source, "init", "-q");
    git("-C", source, "add", ".");
    git(
      "-C",
      source,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "source input",
    );
    const head = git("-C", source, "rev-parse", "HEAD");
    git("clone", "--no-hardlinks", source, prepared);
    const receipt = join(root, "receipt.json");
    writeFileSync(receipt, "{}");
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "scripts/quality-workbench.mjs",
          "--source",
          source,
          "--prepared",
          prepared,
          "--head",
          head,
          "--receipt",
          receipt,
        ],
        { encoding: "utf8" },
      );
    writeFileSync(join(source, "package.json"), '{"changed":true}');
    assert.match(run().stderr, /QUALITY_WORKBENCH_SOURCE_DIRTY/);
    writeFileSync(join(source, "package.json"), "{}");
    writeFileSync(join(prepared, "package.json"), '{"changed":true}');
    assert.match(run().stderr, /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/);
    assert.equal(
      existsSync(join(prepared, "lib")),
      false,
      "rejection precedes any output requirement or build",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
