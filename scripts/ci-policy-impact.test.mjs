import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { selectCiTests } from "../../dsh-agent-workbench/scripts/ci-test-plan.mjs";

test("a dynamic Workbench source-policy change selects the GEA adapter contract", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gea-ci-impact-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (path, ...args) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  const put = (root, file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  const commit = (path) => {
    git(path, "add", ".");
    git(
      path,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "Input",
    );
    return git(path, "rev-parse", "HEAD");
  };
  const repositories = ["dsh-agent-workbench", "dsh-agent-manage", "dsh-gea-plugin"].map((repo) => {
    const path = join(directory, repo);
    mkdirSync(path);
    git(path, "init", "-q");
    put(path, "scripts/ci-source-policy.mjs", "export const revision = 1;");
    return { repo, path, head: commit(path) };
  });
  const own = repositories[2];
  const policy = JSON.parse(readFileSync(new URL("./ci-test-policy.json", import.meta.url)));
  policy.required = ["tests/required.test.mjs"];
  put(own.path, "scripts/ci-test-policy.json", JSON.stringify(policy));
  put(own.path, "scripts/quality-peer-baseline.json", JSON.stringify({ repositories }));
  for (const file of [
    "tests/required.test.mjs",
    "scripts/run-quality-ci.test.mjs",
    "tests/window-launch-admission.test.mjs",
    "scripts/business-profile-ci.test.mjs",
    "tests/unrelated.test.mjs",
    "tests/unrelated.contract.mjs",
  ])
    put(own.path, file, "export const fixture = true;");
  own.head = commit(own.path);
  const base = own.head;
  const peer = repositories[0];
  put(peer.path, "scripts/ci-source-policy.mjs", "export const revision = 2;");
  peer.head = commit(peer.path);
  const plan = selectCiTests({ repositories, repo: own.repo, base });
  assert.deepEqual(plan.changes, [{ repo: peer.repo, file: "scripts/ci-source-policy.mjs" }]);
  assert.ok(
    plan.reasons[peer.repo + "/scripts/ci-source-policy.mjs"].includes(
      "scripts/business-profile-ci.test.mjs",
    ),
    JSON.stringify(plan),
  );
  assert.ok(plan.files.includes("tests/required.test.mjs"));
  assert.ok(plan.files.includes("scripts/run-quality-ci.test.mjs"));
  assert.ok(!plan.files.includes("tests/unrelated.test.mjs"));
});

function resourceImpactFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gea-resource-impact-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (root, ...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const put = (root, file, value) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), value);
  };
  const commit = (root) => {
    git(root, "add", ".");
    git(
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "Input",
    );
    return git(root, "rev-parse", "HEAD");
  };
  const repositories = ["dsh-agent-workbench", "dsh-agent-manage", "dsh-gea-plugin"].map((repo) => {
    const path = join(directory, repo);
    mkdirSync(path);
    git(path, "init", "-q");
    put(path, "README.md", "Fixture source\n");
    return { repo, path, head: commit(path) };
  });
  const own = repositories[2];
  const policy = JSON.parse(readFileSync(new URL("./ci-test-policy.json", import.meta.url)));
  put(own.path, "scripts/ci-test-policy.json", JSON.stringify(policy));
  put(own.path, "scripts/quality-peer-baseline.json", JSON.stringify({ repositories }));
  for (const file of [
    ...policy.required,
    "scripts/ci-policy-impact.test.mjs",
    "tests/sales-plan-action.test.mjs",
    "tests/unrelated.test.mjs",
    "tests/unrelated.contract.mjs",
  ])
    put(own.path, file, "export const fixture = true;\n");
  own.head = commit(own.path);
  const base = own.head;
  return {
    own,
    peer: repositories[0],
    policy,
    change(entry, file, value = "Changed resource\n") {
      put(entry.path, file, value);
      entry.head = commit(entry.path);
    },
    plan: () => selectCiTests({ repositories, repo: own.repo, base }),
  };
}

test("Workbench page resources select GEA page grants and admitted asset integrity without unrelated tests", async (t) => {
  for (const file of [
    "business/inventory-aqkc/source/inventory-light-plugins/src/dsh-ui/DshButton.tsx",
    "business/inventory-dealer/source/inventory-light-plugins/src/dsh-ui/controls.module.css",
    "business/shared/author-questions.css",
    "static/regional/source/index.html",
    "static/category/plugin.json",
    "theme/tokens.css",
    "theme/html-defaults.css",
  ]) {
    await t.test(file, (t) => {
      const fixture = resourceImpactFixture(t);
      fixture.change(fixture.peer, file);
      const plan = fixture.plan();
      assert.deepEqual(plan.changes, [{ repo: fixture.peer.repo, file }]);
      assert.deepEqual(plan.reasons[fixture.peer.repo + "/" + file], [
        "scripts/quality-workbench.test.mjs",
        "tests/business-page-grant.test.mjs",
      ]);
      assert.deepEqual(plan.required, [...fixture.policy.required].sort());
      assert.deepEqual(plan.files, [...fixture.policy.required].sort());
      assert.ok(!plan.files.includes("tests/unrelated.test.mjs"));
      assert.ok(!plan.files.includes("tests/unrelated.contract.mjs"));
    });
  }
});

test("a policy-only source change selects this impact regression despite its exclusive rule", (t) => {
  const fixture = resourceImpactFixture(t);
  fixture.change(
    fixture.own,
    "scripts/ci-test-policy.json",
    JSON.stringify(fixture.policy, null, 2),
  );
  const plan = fixture.plan();
  assert.deepEqual(plan.reasons[fixture.own.repo + "/scripts/ci-test-policy.json"], [
    "scripts/ci-policy-impact.test.mjs",
    "scripts/run-quality-ci.test.mjs",
    "tests/sales-plan-action.test.mjs",
    "tests/window-launch-admission.test.mjs",
  ]);
  assert.deepEqual(
    plan.files,
    [
      ...fixture.policy.required,
      "scripts/ci-policy-impact.test.mjs",
      "tests/sales-plan-action.test.mjs",
    ].sort(),
  );
});

test("unmapped Workbench source still rejects selection", (t) => {
  const fixture = resourceImpactFixture(t);
  fixture.change(fixture.peer, "src/unowned-source.ts");
  assert.throws(
    () => fixture.plan(),
    /CI_TEST_IMPACT_UNMAPPED: dsh-agent-workbench\/src\/unowned-source\.ts/,
  );
});

test("a missing mapped policy regression target still rejects selection", (t) => {
  const fixture = resourceImpactFixture(t);
  fixture.change(
    fixture.own,
    "scripts/ci-test-policy.json",
    JSON.stringify(fixture.policy, null, 2),
  );
  rmSync(join(fixture.own.path, "scripts/ci-policy-impact.test.mjs"));
  assert.throws(
    () => fixture.plan(),
    /CI_TEST_FILE_REQUIRED: scripts\/ci-policy-impact\.test\.mjs/,
  );
});

test("the Workbench sales-plan export selects GEA's actual approval transaction contract", (t) => {
  const fixture = resourceImpactFixture(t);
  fixture.change(fixture.peer, "src/sales-plan.ts", "export const fixture = true;\n");
  const plan = fixture.plan();
  assert.deepEqual(plan.reasons[fixture.peer.repo + "/src/sales-plan.ts"], [
    "tests/sales-plan-action.test.mjs",
  ]);
  assert.deepEqual(plan.required, [...fixture.policy.required].sort());
  assert.deepEqual(
    plan.files,
    [...fixture.policy.required, "tests/sales-plan-action.test.mjs"].sort(),
  );
});

test("a package-only change retains its original configuration contracts without policy consumers", (t) => {
  const fixture = resourceImpactFixture(t);
  fixture.change(fixture.own, "package.json", JSON.stringify({ name: "fixture-package" }));
  const plan = fixture.plan();
  assert.deepEqual(plan.reasons[fixture.own.repo + "/package.json"], [
    "scripts/run-quality-ci.test.mjs",
    "tests/window-launch-admission.test.mjs",
  ]);
  assert.deepEqual(plan.files, [...fixture.policy.required].sort());
});
