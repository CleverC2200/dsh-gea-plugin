import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { selectCiTests } from "../../dsh-agent-workbench/scripts/ci-test-plan.mjs";

const businessCore = [
  "tests/controlled-execution.test.mjs",
  "tests/plugin-sql-cancel.test.mjs",
  "tests/business-page-grant.test.mjs",
  "tests/gateway-handshake.test.mjs",
].sort();

test("a docs-only change keeps the four business contracts without unrelated engineering fixtures", (t) => {
  const fixture = resourceImpactFixture(t);
  fixture.change(fixture.own, "README.md", "Changed documentation\n");
  const plan = fixture.plan();
  assert.deepEqual(plan.required, businessCore);
  assert.deepEqual(plan.files, businessCore);
});

test("engineering source, dynamic commands and configuration reselect the original contracts", async (t) => {
  const { repositories, put, commit } = temporaryGitRepositories(t);
  for (const entry of repositories) {
    const source = new URL(
      entry.repo === "dsh-gea-plugin" ? "../" : "../../" + entry.repo + "/",
      import.meta.url,
    );
    const files = execFileSync(
      "git",
      [
        "ls-files",
        "scripts",
        ...(entry.repo === "dsh-gea-plugin"
          ? [
              "tests",
              ".github",
              "package.json",
              "pnpm-lock.yaml",
              "tsconfig.json",
              "tsconfig.official.json",
              ".oxlintrc.json",
              ".oxfmtrc.json",
              ".qualityignore",
              "quality-baseline.json",
            ]
          : []),
      ],
      { cwd: source, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    for (const file of files) put(entry.path, file, readFileSync(new URL(file, source)));
    entry.head = commit(entry.path);
  }
  const own = repositories[2];
  put(own.path, "scripts/quality-peer-baseline.json", JSON.stringify({ repositories }));
  own.head = commit(own.path);
  const base = own.head;
  const delivery = ["check", "integrity", "readiness", "runtime", "continuation"].map(
    (name) => "scripts/delivery-" + name + ".test.mjs",
  );
  const cases = [
    [
      2,
      "scripts/quality-peer-baseline.json",
      ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [
      0,
      "scripts/quality-peer-baseline.json",
      ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [
      1,
      "scripts/quality-peer-baseline.json",
      ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [2, "scripts/run-quality-checks.mjs", ["scripts/run-quality-checks.test.mjs"]],
    [2, "scripts/quality.mjs", ["scripts/quality.test.mjs", "scripts/quality-policy.test.mjs"]],
    [
      2,
      "scripts/run-quality-ci.mjs",
      ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [2, "scripts/quality-upstreams.mjs", ["scripts/quality-upstreams.test.mjs"]],
    [
      2,
      "scripts/quality-runner-environment.mjs",
      [
        "scripts/quality-runner-environment.test.mjs",
        "scripts/quality-worker-inputs.test.mjs",
        "scripts/quality-prepared-inputs.test.mjs",
      ],
    ],
    [2, "scripts/quality-test-reporter.mjs", ["scripts/quality-test-reporter.test.mjs"]],
    [2, "scripts/quality-workbench.mjs", ["scripts/quality-workbench.test.mjs"]],
    [2, "scripts/run-quality-full.mjs", ["scripts/run-quality-full.test.mjs"]],
    [
      2,
      "scripts/start-isolated-validation.mjs",
      ["tests/window-launch-admission.test.mjs", "tests/source-selection-start.test.mjs"],
    ],
    [2, "scripts/source-combination-integrity.mjs", ["tests/source-integrity.test.mjs"]],
    [2, "scripts/delivery-check.mjs", delivery],
    [
      2,
      "scripts/run-quality-fast.mjs",
      ["scripts/run-quality-checks.test.mjs", "scripts/run-quality-full.test.mjs"],
    ],
    [
      2,
      "scripts/quality-ci-stages.mjs",
      ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [
      2,
      "tests/fixtures/source-window.mjs",
      ["tests/window-launch-admission.test.mjs", "tests/source-selection-start.test.mjs"],
    ],
    [2, ".oxlintrc.json", ["scripts/quality.test.mjs", "scripts/quality-policy.test.mjs"]],
    [2, ".oxfmtrc.json", ["scripts/quality.test.mjs", "scripts/quality-policy.test.mjs"]],
    [2, ".qualityignore", ["scripts/quality.test.mjs", "scripts/quality-policy.test.mjs"]],
    [2, "quality-baseline.json", ["scripts/quality.test.mjs", "scripts/quality-policy.test.mjs"]],
    [
      2,
      "scripts/quality-upstreams.json",
      ["scripts/quality-upstreams.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [
      2,
      "scripts/supported-cores.json",
      ["scripts/quality-workbench.test.mjs", "tests/window-launch-admission.test.mjs"],
    ],
    [2, "scripts/fixtures/quality-ci-commands.mjs", ["scripts/run-quality-ci-stages.test.mjs"]],
    [
      2,
      "package.json",
      [
        "scripts/quality-policy.test.mjs",
        "scripts/quality.test.mjs",
        "scripts/run-quality-ci.test.mjs",
        "scripts/run-quality-full.test.mjs",
        "tests/window-launch-admission.test.mjs",
      ],
    ],
    [
      2,
      "pnpm-lock.yaml",
      [
        "scripts/quality-policy.test.mjs",
        "scripts/run-quality-ci.test.mjs",
        "tests/window-launch-admission.test.mjs",
      ],
    ],
    [
      2,
      "tsconfig.official.json",
      ["scripts/run-quality-ci.test.mjs", "tests/window-launch-admission.test.mjs"],
    ],
    [
      2,
      ".github/workflows/quality.yml",
      ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [
      2,
      ".github/workflows/compatibility.yml",
      ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [2, ".github/workflows/delivery-fixtures.yml", ["scripts/delivery-events.test.mjs"]],
    [
      0,
      "scripts/ci-test-plan.mjs",
      ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [
      0,
      "scripts/candidate-input.mjs",
      [
        "scripts/run-quality-ci.test.mjs",
        "scripts/run-quality-ci-stages.test.mjs",
        "tests/window-launch-admission.test.mjs",
        "tests/source-selection-start.test.mjs",
      ],
    ],
    [0, "scripts/ci-source-policy.mjs", ["scripts/business-profile-ci.test.mjs"]],
    [
      0,
      "scripts/run-quality-ci.mjs",
      ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [
      0,
      "scripts/run-quality-fast.mjs",
      ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [
      1,
      "scripts/run-quality-ci.mjs",
      ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"],
    ],
    [1, "scripts/prepare-official-sdk.mjs", ["scripts/run-quality-ci-stages.test.mjs"]],
    [1, "scripts/sdk-artifact-cache.mjs", ["scripts/run-quality-ci-stages.test.mjs"]],
  ];
  for (const [index, file, expected] of cases)
    await t.test(repositories[index].repo + "/" + file, () => {
      const entry = repositories[index];
      put(entry.path, file, readFileSync(join(entry.path, file), "utf8") + "\n");
      entry.head = commit(entry.path);
      const plan = selectCiTests({ repositories, repo: own.repo, base });
      const selected = plan.reasons[entry.repo + "/" + file];
      for (const regression of expected)
        assert.ok(selected.includes(regression), JSON.stringify({ file, regression, selected }));
      assert.deepEqual(plan.required, businessCore);
    });
});

test("a dynamic Workbench source-policy change selects the GEA adapter contract", (t) => {
  const { repositories, put, commit } = temporaryGitRepositories(t);
  for (const entry of repositories) {
    put(entry.path, "scripts/ci-source-policy.mjs", "export const revision = 1;");
    entry.head = commit(entry.path);
  }
  const own = repositories[2];
  const policy = JSON.parse(readFileSync(new URL("./ci-test-policy.json", import.meta.url)));
  policy.required = ["tests/required.test.mjs"];
  put(own.path, "scripts/ci-test-policy.json", JSON.stringify(policy));
  put(own.path, "scripts/quality-peer-baseline.json", JSON.stringify({ repositories }));
  for (const file of [
    "tests/required.test.mjs",
    ...policy.browserFixtures,
    "scripts/run-quality-ci.test.mjs",
    "tests/window-launch-admission.test.mjs",
    "scripts/business-profile-ci.test.mjs",
    "tests/unrelated.test.mjs",
    "tests/unrelated.contract.mjs",
    "tests/plugin-update-detail.browser.mjs",
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

function temporaryGitRepositories(t) {
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
    return { repo, path };
  });
  return { repositories, put, commit };
}

function resourceImpactFixture(t, authoredFiles = []) {
  const { repositories, put, commit } = temporaryGitRepositories(t);
  for (const entry of repositories) {
    put(entry.path, "README.md", "Fixture source\n");
    entry.head = commit(entry.path);
  }
  const own = repositories[2];
  const policy = JSON.parse(readFileSync(new URL("./ci-test-policy.json", import.meta.url)));
  put(own.path, "scripts/ci-test-policy.json", JSON.stringify(policy));
  put(own.path, "scripts/quality-peer-baseline.json", JSON.stringify({ repositories }));
  for (const file of [
    ...policy.required,
    ...policy.rules.flatMap((rule) => rule.tests),
    ...policy.browserFixtures,
    "scripts/ci-policy-impact.test.mjs",
    "scripts/quality-prepared-inputs.test.mjs",
    "tests/sales-plan-action.test.mjs",
    "tests/branch-stock-ability-web.test.mjs",
    "tests/page-interaction-workbenches.test.mjs",
    "tests/unrelated.test.mjs",
    "tests/unrelated.contract.mjs",
    "tests/plugin-update-detail.browser.mjs",
    ...authoredFiles,
  ])
    put(
      own.path,
      file,
      authoredFiles.includes(file)
        ? readFileSync(new URL("../" + file, import.meta.url))
        : "export const fixture = true;\n",
    );
  own.head = commit(own.path);
  const base = own.head;
  return {
    own,
    repositories,
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
  for (const [file, extra] of [
    [
      "business/inventory-aqkc/source/inventory-light-plugins/src/dsh-ui/DshButton.tsx",
      ["tests/source-integrity.test.mjs", "tests/branch-stock-ability-web.test.mjs"],
    ],
    [
      "business/inventory-dealer/source/inventory-light-plugins/src/dsh-ui/controls.module.css",
      ["tests/source-integrity.test.mjs", "tests/branch-stock-ability-web.test.mjs"],
    ],
    ["business/shared/author-questions.css", []],
    ["static/regional/source/index.html", ["tests/page-interaction-workbenches.test.mjs"]],
    ["static/category/plugin.json", []],
    ["theme/tokens.css", []],
    ["theme/html-defaults.css", []],
  ]) {
    await t.test(file, (t) => {
      const fixture = resourceImpactFixture(t);
      fixture.change(fixture.peer, file);
      const plan = fixture.plan();
      assert.deepEqual(plan.changes, [{ repo: fixture.peer.repo, file }]);
      assert.deepEqual(
        plan.reasons[fixture.peer.repo + "/" + file],
        [
          "scripts/quality-workbench.test.mjs",
          "tests/business-page-grant.test.mjs",
          ...extra,
        ].sort(),
      );
      assert.deepEqual(plan.required, [...fixture.policy.required].sort());
      assert.deepEqual(
        plan.files,
        [
          ...new Set([...fixture.policy.required, "scripts/quality-workbench.test.mjs", ...extra]),
        ].sort(),
      );
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
      "scripts/run-quality-ci.test.mjs",
      "tests/window-launch-admission.test.mjs",
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

test("unknown own and peer commands cannot fall back to configuration tests", (t) => {
  for (const repo of ["dsh-gea-plugin", "dsh-agent-workbench", "dsh-agent-manage"]) {
    const fixture = resourceImpactFixture(t);
    const entry = fixture.repositories.find((entry) => entry.repo === repo);
    fixture.change(entry, "scripts/unowned-command.mjs", "export const value = 1;\n");
    assert.throws(() => fixture.plan(), /CI_TEST_IMPACT_UNMAPPED/);
  }
});

test("peer quality command mappings keep required contracts and fail closed when a rule is missing", (t) => {
  for (const [repo, file] of [
    ["dsh-agent-workbench", "scripts/run-quality-ci.mjs"],
    ["dsh-agent-workbench", "scripts/run-quality-fast.mjs"],
    ["dsh-agent-manage", "scripts/run-quality-ci.mjs"],
  ]) {
    const fixture = resourceImpactFixture(t);
    const peer = fixture.repositories.find((entry) => entry.repo === repo);
    fixture.change(peer, file, "export const changed = true;\n");
    const plan = fixture.plan();
    assert.deepEqual(plan.required, businessCore);
    assert.deepEqual(plan.reasons[`${repo}/${file}`], [
      "scripts/run-quality-ci-stages.test.mjs",
      "scripts/run-quality-ci.test.mjs",
    ]);
    fixture.change(fixture.own, "scripts/ci-test-policy.json", JSON.stringify({
      ...fixture.policy,
      rules: fixture.policy.rules.filter((rule) => rule.repo !== repo || !new RegExp(rule.pattern).test(file)),
    }));
    assert.throws(() => fixture.plan(), /CI_TEST_IMPACT_UNMAPPED/);
  }
  const fixture = resourceImpactFixture(t);
  fixture.change(fixture.repositories[1], "scripts/check-static.mjs", "export const unknown = true;\n");
  assert.throws(() => fixture.plan(), /CI_TEST_IMPACT_UNMAPPED: dsh-agent-manage\/scripts\/check-static\.mjs/);
});

test("the prepared tar helper selects its CLI regression while an unknown Python source still rejects", (t) => {
  const fixture = resourceImpactFixture(t);
  fixture.change(
    fixture.own,
    "scripts/quality-prepared-inputs.test.mjs",
    'import {spawnSync} from "node:child_process"; spawnSync("python3", ["scripts/quality-prepared-tar.py"]);\n',
  );
  fixture.change(fixture.own, "scripts/quality-prepared-tar.py", "# changed tar implementation\n");
  const plan = fixture.plan();
  assert.deepEqual(plan.reasons[fixture.own.repo + "/scripts/quality-prepared-tar.py"], [
    "scripts/quality-prepared-inputs.test.mjs",
  ]);
  assert.ok(plan.files.includes("scripts/quality-prepared-inputs.test.mjs"));
  assert.ok(!plan.files.includes("tests/unrelated.test.mjs"));
  fixture.change(fixture.own, "scripts/unknown-transport.py", "# unmapped implementation\n");
  assert.throws(
    () => fixture.plan(),
    /CI_TEST_IMPACT_UNMAPPED: dsh-gea-plugin\/scripts\/unknown-transport\.py/,
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

test("the dynamically loaded test reporter selects its real consumers while an unknown reporter rejects", (t) => {
  const fixture = resourceImpactFixture(t);
  writeFileSync(
    join(fixture.own.path, "scripts/quality-test-execution.test.mjs"),
    "export const fixture = true;\n",
  );
  fixture.change(
    fixture.own,
    "scripts/quality-test-reporter.mjs",
    "export default async function* reporter() {}\n",
  );
  const plan = fixture.plan();
  assert.deepEqual(plan.reasons[fixture.own.repo + "/scripts/quality-test-reporter.mjs"], [
    "scripts/quality-test-execution.test.mjs",
    "scripts/quality-test-reporter.test.mjs",
    "scripts/run-quality-ci-stages.test.mjs",
  ]);
  assert.ok(!plan.files.includes("tests/unrelated.test.mjs"));
  fixture.change(
    fixture.own,
    "scripts/unknown-reporter.mjs",
    "export default async function* reporter() {}\n",
  );
  assert.throws(
    () => fixture.plan(),
    /CI_TEST_IMPACT_UNMAPPED: dsh-gea-plugin\/scripts\/unknown-reporter\.mjs/,
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

test("a package-only change retains affected tool and configuration contracts", (t) => {
  const fixture = resourceImpactFixture(t);
  fixture.change(fixture.own, "package.json", JSON.stringify({ name: "fixture-package" }));
  const plan = fixture.plan();
  const expected = [
    "scripts/quality-policy.test.mjs",
    "scripts/quality.test.mjs",
    "scripts/run-quality-ci.test.mjs",
    "scripts/run-quality-full.test.mjs",
    "tests/window-launch-admission.test.mjs",
  ];
  assert.deepEqual(plan.reasons[fixture.own.repo + "/package.json"], expected);
  assert.deepEqual(plan.files, [...fixture.policy.required, ...expected].sort());
});

test("detail contributions select the built browser and actual installer contracts", (t) => {
  const fixture = resourceImpactFixture(t);
  for (const file of [
    "tests/plugin-update-controller.contract.mjs",
    "tests/plugin-update-integration.contract.mjs",
    "tests/plugin-update-install.contract.mjs",
    "tests/plugin-update-detail.browser.mjs",
    "tests/plugin-release-source.test.mjs",
    "tests/plugin-release.test.mjs",
  ])
    writeFileSync(
      join(fixture.own.path, file),
      file.endsWith(".browser.mjs")
        ? "import { chromium } from '@playwright/test'; await chromium.launch();"
        : "export const fixture = true;\n",
    );
  fixture.change(fixture.own, "src/plugin-detail-updates.tsx", "export const changed = true;\n");
  const plan = fixture.plan();
  assert.ok(plan.files.includes("tests/plugin-update-install.contract.mjs"), JSON.stringify(plan));
  assert.ok(plan.files.includes("tests/plugin-update-detail.browser.mjs"), JSON.stringify(plan));
  assert.equal(plan.browser, true);
});

test("retiring the Cube-only MCP module selects the knowledge and Cube bridge regressions", (t) => {
  const { repositories, put, commit } = temporaryGitRepositories(t);
  for (const entry of repositories) {
    put(entry.path, "input.txt", "baseline");
    entry.head = commit(entry.path);
  }
  const own = repositories[2];
  const policy = JSON.parse(readFileSync(new URL("./ci-test-policy.json", import.meta.url)));
  policy.required = ["tests/required.test.mjs"];
  policy.rules = policy.rules.filter((rule) => rule.tests.includes("tests/knowledge-mcp.test.mjs"));
  put(own.path, "scripts/ci-test-policy.json", JSON.stringify(policy));
  put(own.path, "scripts/quality-peer-baseline.json", JSON.stringify({ repositories }));
  const expected = [...new Set(policy.rules.flatMap((rule) => rule.tests))];
  for (const file of [
    "tests/required.test.mjs",
    ...policy.browserFixtures,
    "tests/unrelated.test.mjs",
    "scripts/unrelated.test.mjs",
    "tests/unrelated.contract.mjs",
    "tests/unrelated.browser.mjs",
    ...expected,
  ])
    put(own.path, file, "export const fixture = true;");
  put(own.path, "src/host/cube-mcp-client.ts", "export const previous = true;");
  own.head = commit(own.path);
  const base = own.head;
  rmSync(join(own.path, "src/host/cube-mcp-client.ts"));
  put(own.path, "src/host/gateway-mcp-client.ts", "export const current = true;");
  put(own.path, "src/host/knowledge-mcp.ts", "export const knowledge = true;");
  own.head = commit(own.path);
  const plan = selectCiTests({ repositories, repo: own.repo, base });
  for (const file of expected) assert.ok(plan.files.includes(file), file);
  assert.ok(
    plan.reasons[own.repo + "/src/host/cube-mcp-client.ts"].includes(
      "tests/knowledge-mcp.test.mjs",
    ),
  );
  assert.ok(!plan.files.includes("tests/unrelated.test.mjs"));
});
