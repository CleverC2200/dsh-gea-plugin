import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { selectCiTests } from "../../dsh-agent-workbench/scripts/ci-test-plan.mjs";

const businessCore = [
  "tests/controlled-execution.test.mjs",
  "tests/plugin-sql-cancel.test.mjs",
  "tests/business-page-grant.test.mjs",
  "tests/gateway-handshake.test.mjs",
  "scripts/runtime-environment.test.mjs",
  "tests/plugin-release-preflight.test.mjs",
  "tests/plugin-release.test.mjs",
  "tests/optional-companion-manifest.test.mjs",
].sort();

test("desktop unit changes select their real CJS or MJS behavior without enabling Electron acceptance", async (t) => {
  for (const [source, regression] of [
    ["desktop/runtime-cookies.cjs", "desktop/runtime-cookies.test.cjs"],
    ["desktop/navigation.cjs", "desktop/navigation.test.cjs"],
    ["desktop/permissions.cjs", "desktop/permissions.test.mjs"],
    ["desktop/updates.mjs", "desktop/updates.test.mjs"],
    ["desktop/optimize-client-artifacts.mjs", "desktop/optimize-client-artifacts.test.mjs"],
  ])
    await t.test(source, (t) => {
      const fixture = resourceImpactFixture(t, ["scripts/desktop-gea-upgrade.test.mjs"], {
        desktop: true,
      });
      fixture.change(
        fixture.own,
        source,
        readFileSync(new URL("../" + source, import.meta.url), "utf8") + "\n",
      );
      const plan = fixture.plan();
      assert.equal(
        plan.files.filter((file) => file === regression).length,
        1,
        JSON.stringify(plan),
      );
      assert.ok(plan.reasons[`${fixture.own.repo}/${source}`].includes(regression));
      assert.ok(!plan.files.includes("desktop/startup-state.test.mjs"));
      assert.ok(!plan.files.includes("desktop/business-ready.test.mjs"));
      assert.ok(!plan.files.includes("desktop/update-speed-smoke.mjs"));
    });
});

test("desktop wrapper children have one execution owner instead of a second independent run", (t) => {
  const child = "desktop/company-bootstrap.test.mjs",
    owner = "scripts/desktop-gea-upgrade.test.mjs";
  const fixture = resourceImpactFixture(t, [owner], { desktop: true });
  fixture.change(
    fixture.own,
    child,
    readFileSync(new URL("../" + child, import.meta.url), "utf8") + "\n",
  );
  const plan = fixture.plan();
  assert.equal(plan.files.filter((file) => file === owner).length, 1);
  assert.ok(!plan.files.includes(child));
  assert.equal(plan.executedBy[child], owner);
});

test("a docs-only change declares no source, browser or runtime obligation", (t) => {
  const fixture = resourceImpactFixture(t);
  fixture.change(fixture.own, "README.md", "Changed documentation\n");
  const plan = fixture.plan();
  assert.equal(plan.applicability, "docs");
  assert.deepEqual(plan.required, businessCore);
  assert.deepEqual(plan.files, []);
  assert.equal(plan.browser, false);
  assert.equal(plan.runtime, false);
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
              "desktop",
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
    for (const file of files)
      if (existsSync(new URL(file, source)))
        put(entry.path, file, readFileSync(new URL(file, source)));
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
    [2, "scripts/run-quality-fast.mjs", ["scripts/run-quality-checks.test.mjs"]],
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
    [0, "scripts/check-agent-knowledge.mjs", ["scripts/run-quality-ci-stages.test.mjs"]],
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

function resourceImpactFixture(t, authoredFiles = [], { desktop = false } = {}) {
  const { repositories, put, commit } = temporaryGitRepositories(t);
  for (const entry of repositories) {
    put(entry.path, "README.md", "Fixture source\n");
    entry.head = commit(entry.path);
  }
  const own = repositories[2];
  const policy = JSON.parse(readFileSync(new URL("./ci-test-policy.json", import.meta.url)));
  if (!desktop) {
    policy.tests = policy.tests.filter((pattern) => !pattern.startsWith("desktop/"));
    delete policy.testOwners;
  }
  put(own.path, "scripts/ci-test-policy.json", JSON.stringify(policy));
  put(own.path, "scripts/quality-peer-baseline.json", JSON.stringify({ repositories }));
  for (const file of [
    ...policy.required,
    ...policy.tests.filter((file) => file.startsWith("desktop/")),
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
      authoredFiles.includes(file) || (desktop && file.startsWith("desktop/"))
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
    plan: () =>
      selectCiTests({ repositories, repo: own.repo, base, testOwners: policy.testOwners }),
  };
}

const workbenchBuildContracts = [
  "scripts/quality-prepared-inputs.test.mjs",
  "scripts/quality-workbench.test.mjs",
  "scripts/run-quality-ci-stages.test.mjs",
];

test("Workbench compiled version changes select loaded Host and client identity contracts", (t) => {
  const fixture = resourceImpactFixture(t);
  const file = "src/plugin-package-version.ts";
  fixture.change(
    fixture.peer,
    file,
    'export const pluginPackageVersion = Object.freeze({ name: "@cleverc2200/dsh-agent-workbench", version: "0.1.13" });\n',
  );
  const plan = fixture.plan();
  const contract = "tests/plugin-update-integration.contract.mjs";
  assert.deepEqual(plan.changes, [{ repo: fixture.peer.repo, file }]);
  assert.deepEqual(plan.reasons[fixture.peer.repo + "/" + file], [contract]);
  assert.deepEqual(plan.files, [...businessCore, contract].sort());
  fixture.change(fixture.peer, "src/plugin-package-version-extra.ts");
  assert.throws(() => fixture.plan(), /CI_TEST_IMPACT_UNMAPPED/);
});

test("Workbench build commands select prepared assets, frozen transport and build failure contracts", async (t) => {
  for (const name of [
    "build",
    "build-aps-metrics",
    "build-customer-prototype",
    "build-dms-prototype",
    "build-inventory",
    "build-order-fulfillment",
    "build-output",
    "build-static-authors",
    "static-author-provenance",
  ]) {
    await t.test(name, (t) => {
      const fixture = resourceImpactFixture(t);
      const file = `scripts/${name}.mjs`;
      assert.equal(existsSync(join(fixture.peer.path, file)), false);
      fixture.change(fixture.peer, file, "export const fixture = true;\n");
      const plan = fixture.plan();
      assert.deepEqual(plan.changes, [{ repo: fixture.peer.repo, file }]);
      assert.deepEqual(plan.reasons[fixture.peer.repo + "/" + file], workbenchBuildContracts);
      assert.deepEqual(plan.required, businessCore);
      assert.deepEqual(plan.files, [...businessCore, ...workbenchBuildContracts].sort());
    });
  }
});

test("named peer-private CI inputs select no GEA execution without an actual consumer", async (t) => {
  for (const [repo, files] of [
    [
      "dsh-agent-workbench",
      ["quality.mjs", "run-quality-ci.mjs", "run-quality-fast.mjs", "ci-test-policy.json"],
    ],
    [
      "dsh-agent-manage",
      [
        "check-preset-capabilities.mjs",
        "download-cache.mjs",
        "preset-test-lanes.mjs",
        "run-quality-ci.mjs",
        "write-ci-input.mjs",
        "ci-test-policy.json",
      ],
    ],
  ])
    for (const name of files) {
      await t.test(repo + "/" + name, (t) => {
        const fixture = resourceImpactFixture(t);
        const peer = fixture.repositories.find((entry) => entry.repo === repo);
        const file = `scripts/${name}`;
        fixture.change(
          peer,
          file,
          name.endsWith(".json") ? "{}\n" : "export const fixture = true;\n",
        );
        const plan = fixture.plan();
        assert.deepEqual(plan.changes, [{ repo, file }]);
        assert.deepEqual(plan.reasons[repo + "/" + file], []);
        assert.deepEqual(plan.required, businessCore);
        assert.deepEqual(plan.files, businessCore);
      });
    }
});

test("explicit peer CI mappings preserve additional executable GEA import consumers", async (t) => {
  for (const [repo, file, contracts] of [
    ["dsh-agent-workbench", "scripts/build-output.mjs", workbenchBuildContracts],
    ["dsh-agent-manage", "scripts/download-cache.mjs", []],
    ["dsh-agent-workbench", "scripts/run-quality-fast.mjs", []],
    [
      "dsh-agent-workbench",
      "scripts/check-agent-knowledge.mjs",
      ["scripts/run-quality-ci-stages.test.mjs"],
    ],
  ]) {
    await t.test(repo + "/" + file, (t) => {
      const fixture = resourceImpactFixture(t);
      const peer = fixture.repositories.find((entry) => entry.repo === repo);
      const consumer = "tests/additional-peer-consumer.test.mjs";
      fixture.change(peer, file, "export const fixture = true;\n");
      fixture.change(fixture.own, consumer, `import "../../${repo}/${file}";\n`);
      const plan = fixture.plan();
      assert.deepEqual(plan.reasons[repo + "/" + file], [...contracts, consumer].sort());
      assert.deepEqual(plan.required, businessCore);
      assert.deepEqual(plan.files, [...businessCore, ...contracts, consumer].sort());
    });
  }
});

test("peer CI mappings reject unowned adjacent command names", (t) => {
  for (const [repo, file] of [
    ["dsh-agent-workbench", "scripts/build-unowned.mjs"],
    ["dsh-agent-manage", "scripts/download-cache-unowned.mjs"],
    ["dsh-agent-manage", "scripts/run-quality-ci-unowned.mjs"],
    ["dsh-agent-workbench", "scripts/check-agent-knowledge-unowned.mjs"],
    ["dsh-agent-workbench", "scripts/run-quality-fast-unowned.mjs"],
    ["dsh-agent-manage", "scripts/write-ci-input-unowned.mjs"],
  ]) {
    const fixture = resourceImpactFixture(t);
    const peer = fixture.repositories.find((entry) => entry.repo === repo);
    fixture.change(peer, file, "export const fixture = true;\n");
    assert.throws(() => fixture.plan(), {
      message: "CI_TEST_IMPACT_UNMAPPED: " + repo + "/" + file,
    });
  }
});

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

test("the package-manager subprocess fixture selects its update controller consumer", (t) => {
  const fixture = resourceImpactFixture(t);
  fixture.change(
    fixture.own,
    "tests/fixtures/plugin-updates/package-manager.cjs",
    "process.exit(1);\n",
  );
  const plan = fixture.plan();
  assert.ok(plan.files.includes("tests/plugin-update-controller.contract.mjs"));
  assert.ok(
    plan.reasons[fixture.own.repo + "/tests/fixtures/plugin-updates/package-manager.cjs"].includes(
      "tests/plugin-update-controller.contract.mjs",
    ),
  );
});

test("browser-only changes and their dedicated fixtures select their browser consumer", async (t) => {
  for (const changed of [
    "tests/plugin-update-list.browser.mjs",
    "tests/fixtures/plugin-updates/list-browser.tsx",
  ]) {
    await t.test(changed, (t) => {
      const file = "tests/plugin-update-list.browser.mjs";
      const fixture = resourceImpactFixture(t, [
        file,
        "tests/fixtures/plugin-updates/list-browser.tsx",
      ]);
      fixture.change(
        fixture.own,
        changed,
        readFileSync(new URL("../" + changed, import.meta.url), "utf8") + "\n",
      );
      const plan = fixture.plan();
      assert.ok(plan.files.includes(file), JSON.stringify(plan));
      assert.ok(plan.reasons[fixture.own.repo + "/" + changed].includes(file));
      assert.equal(plan.browser, true);
      assert.deepEqual(plan.required, businessCore);
      assert.ok(!plan.files.includes("tests/unrelated.test.mjs"));
    });
  }
});

test("the shared returned-review fixture selects every isolated browser scenario", (t) => {
  const consumers = [
    "tests/returned-resubmit-web.test.mjs",
    "tests/returned-review-roles-web.test.mjs",
    "tests/returned-review-reject-web.test.mjs",
  ];
  const shared = "tests/fixtures/returned-review.mjs";
  const fixture = resourceImpactFixture(t, [...consumers, shared, "tests/profile.mjs"]);
  fixture.change(
    fixture.own,
    shared,
    readFileSync(new URL("../" + shared, import.meta.url), "utf8") + "\n",
  );
  const plan = fixture.plan();
  assert.ok(
    consumers.every((file) => plan.files.includes(file)),
    JSON.stringify(plan),
  );
  assert.equal(plan.browser, true);
  assert.ok(
    consumers.every((file) => plan.runtimeFiles.includes(file)),
    JSON.stringify(plan),
  );
});

test("retiring the Cube-only MCP module selects the knowledge and Cube bridge regressions", (t) => {
  const { repositories, put, commit } = temporaryGitRepositories(t);
  for (const entry of repositories) {
    put(entry.path, "input.txt", "baseline");
    entry.head = commit(entry.path);
  }
  const own = repositories[2];
  const policy = JSON.parse(readFileSync(new URL("./ci-test-policy.json", import.meta.url)));
  policy.tests = policy.tests.filter((pattern) => !pattern.startsWith("desktop/"));
  delete policy.testOwners;
  policy.required = ["tests/required.test.mjs"];
  policy.rules = policy.rules.filter((rule) => rule.tests.includes("tests/knowledge-mcp.test.mjs"));
  put(own.path, "scripts/ci-test-policy.json", JSON.stringify(policy));
  put(own.path, "scripts/quality-peer-baseline.json", JSON.stringify({ repositories }));
  const expected = [...new Set(policy.rules.flatMap((rule) => rule.tests))];
  for (const file of [
    "tests/required.test.mjs",
    ...policy.tests.filter((file) => !file.includes("*")),
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

test("complete package inputs select existing release and platform contracts", async (t) => {
  const regressions = [
    "scripts/windows-complete-local/input.test.mjs",
    "scripts/delivery-events.test.mjs",
    "scripts/package-desktop.test.mjs",
    "tests/plugin-release-source.test.mjs",
  ];
  for (const source of [
    "scripts/mac-complete-local/build.mjs",
    "scripts/windows-complete-local/build.mjs",
    "scripts/windows-complete-local/input.mjs",
    "scripts/windows-complete-local/input.test.mjs",
    "scripts/windows-complete-local/released-input.fixture.json",
    "scripts/windows-complete-local/run-bundle.mjs",
    "scripts/windows-complete-local/legacy-bootstrap.mjs",
  ])
    await t.test(source, (t) => {
      const fixture = resourceImpactFixture(t);
      fixture.change(fixture.own, source);
      const plan = fixture.plan();
      for (const file of regressions)
        assert.ok(
          plan.reasons[fixture.own.repo + "/" + source].includes(file),
          JSON.stringify(plan),
        );
      assert.deepEqual(plan.required, businessCore);
    });
});
