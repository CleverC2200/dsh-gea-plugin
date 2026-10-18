import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parse } from "yaml";
import {
  windowsNativeEntrypoints,
  windowsNativeInput,
  windowsUpdateImpact,
  windowsUpdateScope,
} from "./ci-windows-update.mjs";
import { assessHostedBudget } from "./quality-hosted-budget.mjs";

test("native update impact covers implementation, fixture and gate changes without unrelated work", () => {
  for (const file of [
    "src/host/plugin-update-controller.ts",
    "src/host/plugin-update-windows.ts",
    "src/host/plugin-release-source.ts",
    "src/shared/plugin-update-state.ts",
    "src/shared/plugin-release.mjs",
    "tests/plugin-update-windows.native.mjs",
    "tests/plugin-update-install.contract.mjs",
    "tests/fixtures/plugin-updates/pnpm-profile.mjs",
    "scripts/check-windows-plugin-update.mjs",
    "scripts/ci-windows-update.mjs",
    "package.json",
    "pnpm-lock.yaml",
    ".github/workflows/quality.yml",
  ])
    assert.deepEqual(windowsUpdateImpact([file]), { applicable: true, matched: [file] });
  assert.deepEqual(windowsUpdateImpact(["README.md", "src/host/knowledge-mcp.ts"]), {
    applicable: false,
    matched: [],
  });
  for (const files of [undefined, ["../src/host/plugin-update-windows.ts"], ["a\nb"]])
    assert.throws(() => windowsUpdateImpact(files), /WINDOWS_UPDATE_DIFF_REQUIRED/);
});

test("native impact includes every local dependency of the real runner, controller and fixture", async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    entryPoints: [
      "scripts/check-windows-plugin-update.mjs",
      ...Object.values(windowsNativeEntrypoints),
    ],
    outdir: ".runtime/windows-update-impact-test",
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const dependencies = Object.keys(result.metafile.inputs).map((file) =>
    file.replaceAll("\\", "/"),
  );
  assert.ok(dependencies.includes("src/host/plugin-release-source.ts"));
  for (const file of dependencies)
    assert.equal(windowsUpdateImpact([file]).applicable, true, `uncovered native input: ${file}`);
});

test("scope binds the real head and full diff including removal, without a branch-name exception", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gea-windows-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const commit = () => {
    git("add", "-A");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  mkdirSync(join(root, "src/host"), { recursive: true });
  writeFileSync(join(root, "src/host/plugin-update-windows.ts"), "export {};\n");
  const base = commit();
  writeFileSync(join(root, "README.md"), "Documentation\n");
  const documentation = commit();
  assert.equal(windowsUpdateScope({ root, head: documentation, base }).applicable, false);
  rmSync(join(root, "src/host/plugin-update-windows.ts"));
  const head = commit();
  const scope = windowsUpdateScope({ root, head, base: documentation });
  assert.deepEqual(scope.matched, ["src/host/plugin-update-windows.ts"]);
  assert.equal(scope.sourceHead, head);
  assert.equal(scope.runtime.coreHead, windowsNativeInput.coreHead);
  assert.throws(() => windowsUpdateScope({ root, head: documentation, base }), /EVENT_MISMATCH/);
  assert.throws(() => windowsUpdateScope({ root, head, base: "main" }), /COMMITS_REQUIRED/);
});

test("quality awaits the native or explicit not-applicable job and records its fixed runtime scope", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/quality.yml", import.meta.url), "utf8"),
  );
  const native = workflow.jobs["windows-plugin-update"];
  assert.equal(native.needs, "candidate-scope");
  assert.match(native["runs-on"], /windows-applicable.*windows-2025.*ubuntu-latest/);
  assert.equal(native.if, undefined);
  assert.ok(workflow.jobs["candidate-quality"].needs.includes("windows-plugin-update"));
  assert.equal(
    native.env.QUALITY_WINDOWS_APPLICABLE,
    "${{ needs.candidate-scope.outputs.windows-applicable }}",
  );
  assert.ok(native.steps.some((step) => step.run === "node scripts/ci-windows-update.mjs"));
  const execute = native.steps.find((step) =>
    step.run?.includes("node scripts/check-windows-plugin-update.mjs"),
  );
  assert.equal(execute.if, "needs.candidate-scope.outputs.windows-applicable == 'true'");
  assert.match(windowsNativeInput.coreHead, /^[a-f0-9]{40}$/);
  assert.match(windowsNativeInput.installerSha256, /^[a-f0-9]{64}$/);
  assert.equal(new URL(windowsNativeInput.installerUrl).protocol, "https:");
  assert.match(windowsNativeInput.acceptance, /not current-Core joint/);
});

test("native failure, cancellation, omission and skipped jobs cannot satisfy the final functional gate", () => {
  const expected = {
    repository: "CleverC2200/dsh-gea-plugin",
    runId: 1,
    runAttempt: 1,
    headSha: "a".repeat(40),
  };
  const at = "2026-10-18T00:00:00Z";
  const finished = "2026-10-18T00:00:01Z";
  const job = (name, id, conclusion) => ({
    id,
    name,
    run_id: 1,
    run_attempt: 1,
    head_sha: expected.headSha,
    status: "completed",
    conclusion,
    started_at: at,
    completed_at: finished,
  });
  for (const conclusion of ["success", "failure", "cancelled", "skipped", null]) {
    const jobs = [
      job("candidate-quality", 1, "success"),
      ...(conclusion ? [job("windows-plugin-update", 2, conclusion)] : []),
    ];
    const result = assessHostedBudget({
      requiredJobs: ["windows-plugin-update"],
      finalJobName: "candidate-quality",
      mode: "completed",
      now: finished,
      snapshot: {
        schemaVersion: 1,
        expected,
        observedAt: finished,
        pagination: { complete: true, totalCount: jobs.length, pageCount: 1, perPage: 100 },
        run: {
          id: 1,
          run_attempt: 1,
          head_sha: expected.headSha,
          status: "completed",
          conclusion: "success",
          created_at: at,
          run_started_at: at,
          updated_at: finished,
        },
        jobs,
      },
    });
    assert.equal(result.functional.status === "passed", conclusion === "success");
  }
});
