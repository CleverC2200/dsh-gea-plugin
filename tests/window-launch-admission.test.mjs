import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSourceProfile } from "../scripts/start-isolated-validation.mjs";

test("omitting a window cannot enter the public source Host implementation", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "window-admission-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const runtime = join(temporary, "runtime");
  const before = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED,
  };
  await assert.rejects(runSourceProfile("/absent-core", runtime), /WINDOW_DECLARATION_REQUIRED/);
  await assert.rejects(access(runtime), { code: "ENOENT" });
  assert.deepEqual(
    {
      DSH_HOME: process.env.DSH_HOME,
      DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED,
    },
    before,
  );
});

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
for (const [entry, arguments_] of [
  ["start.mjs", ["--config", "/absent-deployment", "--runtime", "/absent-runtime"]],
  ["start-isolated-validation.mjs", ["--core", "/absent-core"]],
])
  test(`${entry} refuses an omitted declaration before reading configuration or creating a profile`, () => {
    const result = spawnSync(process.execPath, [resolve("scripts", entry), ...arguments_], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WINDOW_DECLARATION_REQUIRED/);
  });

import { writeFile, readFile, realpath, mkdir, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function declaration(t, changes = {}) {
  const directory = await mkdtemp(join(tmpdir(), "window-declaration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const frozenFile = join(directory, "frozen-window.json");
  const frozen = {
    file: "frozen-window.json",
    case: "current-fixture",
    owner: "fixture-owner",
    ...changes.frozen,
  };
  const bytes = JSON.stringify(frozen);
  await writeFile(frozenFile, bytes);
  const windowFile = join(directory, "window.json");
  await writeFile(
    windowFile,
    JSON.stringify({
      case: frozen.case,
      owner: frozen.owner,
      status: "open",
      paused: false,
      freeze: { file: frozenFile },
      ...changes.window,
    }),
  );
  return {
    file: windowFile,
    case: "current-fixture",
    owner: "fixture-owner",
    freezeSha256: digest(bytes),
    runtime: join(directory, "runtime"),
  };
}

test("a closed declaration refuses the public Host before any runtime directory exists", async (t) => {
  const request = await declaration(t, { window: { status: "closed" } });
  const before = await readFile(request.file);
  await assert.rejects(
    runSourceProfile("/absent-core", request.runtime, false, undefined, 0, {
      window: request,
    }),
    /WINDOW_NOT_OPEN/,
  );
  assert.deepEqual(await readFile(request.file), before);
  await assert.rejects(access(request.runtime), { code: "ENOENT" });
});

test("unknown remaining calls remain unknown and block the public Host before effects", async (t) => {
  const budget = {
    limits: {
      hostStarts: 1,
      businessRequests: 0,
      modelTasks: 0,
      businessWrites: 0,
    },
    remaining: {
      hostStarts: 1,
      businessRequests: "unknown",
      modelTasks: 0,
      businessWrites: 0,
    },
  };
  const request = await declaration(t, {
    frozen: { budget },
    window: { budget },
  });
  await assert.rejects(
    runSourceProfile("/absent-core", request.runtime, false, undefined, 0, {
      window: request,
    }),
    /WINDOW_BUDGET_UNKNOWN/,
  );
  await assert.rejects(access(request.runtime), { code: "ENOENT" });
});

import { sourceWindow, snapshot, hash } from "./fixtures/source-window.mjs";
test("a frozen wrong candidate head is rejected through the default CLI with zero protected effects", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  const input = JSON.parse(await readFile(fixture.candidateFile, "utf8"));
  input.repositories[0].head = "0".repeat(40);
  await writeFile(fixture.candidateFile, JSON.stringify(input));
  fixture.frozen.candidate.sha256 = hash(await readFile(fixture.candidateFile));
  await fixture.refresh();
  const before = await snapshot(fixture.runtime);
  const result = fixture.run();
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.equal(result.status, 1, JSON.stringify({ stderr: result.stderr, effects }));
  assert.match(result.stderr, /CANDIDATE_HEAD/);
  assert.deepEqual(effects.writes, []);
  assert.deepEqual(effects.processes, []);
  assert.deepEqual(effects.network, []);
  assert.deepEqual(effects.after, effects.before);
  assert.deepEqual(await snapshot(fixture.runtime), before);
});

test("the correctly frozen source-host enters only the loopback process fixture through the same CLI", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOCAL_LOOPBACK_FIXTURE_ONLY/);
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.equal(effects.processes.length, 1);
  assert.equal(
    await realpath(effects.processes[0].args[0]),
    await realpath(join(fixture.fixedCore, "apps/cli/lib/bin.js")),
  );
  assert.deepEqual(effects.network, []);
});

test("the isolated core CLI preserves its platform sandbox boundary after Window admission", async (t) => {
  const fixture = await sourceWindow(t, "isolated-core-host");
  const before = await snapshot(fixture.runtime);
  const result = fixture.run("start-isolated-validation.mjs");
  if (process.platform !== "darwin") {
    await assertNoEffects(fixture, result, /ISOLATED_VALIDATION_REQUIRES_MACOS_SANDBOX/, before);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOCAL_LOOPBACK_FIXTURE_ONLY/);
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.equal(effects.processes.length, 1);
  assert.equal(effects.processes[0].command, "/usr/bin/sandbox-exec");
  assert.deepEqual(effects.network, []);
});

test("a self-consistent artifact manifest cannot replace the frozen candidate source binding", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  const directory = join(fixture.runtime, "source-combinations", fixture.frozen.combination.id);
  const file = join(directory, "company-plugins.json");
  const plugins = JSON.parse(await readFile(file, "utf8"));
  plugins["@cleverc2200/gea-dsh-prototype"].commit = "0".repeat(40);
  await writeFile(file, JSON.stringify(plugins));
  const manifestFile = join(directory, "combination.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.files["company-plugins.json"] = hash(await readFile(file));
  await writeFile(manifestFile, JSON.stringify(manifest));
  fixture.frozen.combination.manifestSha256 = hash(await readFile(manifestFile));
  await writeFile(
    join(fixture.runtime, "source-selection.json"),
    JSON.stringify({
      id: fixture.frozen.combination.id,
      manifestSha256: fixture.frozen.combination.manifestSha256,
    }),
  );
  await fixture.refresh();
  const result = fixture.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /WINDOW_SOURCE_CANDIDATE_MISMATCH/);
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.deepEqual(effects.writes, []);
  assert.deepEqual(effects.processes, []);
  assert.deepEqual(effects.after, effects.before);
});

test("the isolated source CLI preserves its platform sandbox boundary after Window admission", async (t) => {
  const fixture = await sourceWindow(t, "isolated-source-host");
  const before = await snapshot(fixture.runtime);
  const result = fixture.run("start-isolated-validation.mjs");
  if (process.platform !== "darwin") {
    await assertNoEffects(fixture, result, /ISOLATED_VALIDATION_REQUIRES_MACOS_SANDBOX/, before);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOCAL_LOOPBACK_FIXTURE_ONLY/);
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.equal(effects.processes.length, 1);
  assert.equal(effects.processes[0].command, "/usr/bin/sandbox-exec");
  assert.deepEqual(effects.network, []);
});

async function assertNoEffects(fixture, result, expected, before) {
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.equal(result.status, 1, JSON.stringify({ stderr: result.stderr, effects }));
  assert.match(result.stderr, expected, JSON.stringify(effects));
  assert.deepEqual(effects.writes, []);
  assert.deepEqual(effects.processes, []);
  assert.deepEqual(effects.network, []);
  assert.deepEqual(effects.credentialReads, []);
  assert.deepEqual(effects.after, effects.before);
  assert.deepEqual(await snapshot(fixture.runtime), before);
}
const invalidDeclarations = [
  [
    "closed",
    (fixture) => {
      fixture.current.status = "closed";
    },
    /WINDOW_NOT_OPEN/,
  ],
  [
    "paused",
    (fixture) => {
      fixture.current.paused = true;
    },
    /WINDOW_PAUSED/,
  ],
  [
    "case",
    (fixture) => {
      fixture.current.case = "another-window";
    },
    /WINDOW_CASE_MISMATCH/,
  ],
  [
    "owner",
    (fixture) => {
      fixture.current.owner = "another-owner";
    },
    /WINDOW_OWNER_MISMATCH/,
  ],
  [
    "mode",
    (fixture) => {
      fixture.frozen.mode = "unsupported-native-shell";
    },
    /WINDOW_MODE_MISMATCH/,
  ],
  [
    "budget mismatch",
    (fixture) => {
      fixture.current.budget.limits.businessRequests = 1;
    },
    /WINDOW_BUDGET_MISMATCH/,
  ],
  [
    "unknown budget",
    (fixture) => {
      fixture.current.budget.remaining.businessRequests = "unknown";
    },
    /WINDOW_BUDGET_UNKNOWN/,
  ],
  [
    "missing budget",
    (fixture) => {
      delete fixture.current.budget.remaining.businessRequests;
    },
    /WINDOW_BUDGET_REQUIRED/,
  ],
  [
    "exhausted starts",
    (fixture) => {
      fixture.current.budget.remaining.hostStarts = 0;
      fixture.frozen.budget.remaining.hostStarts = 0;
    },
    /WINDOW_BUDGET_EXHAUSTED/,
  ],
  [
    "runtime",
    (fixture) => {
      fixture.frozen.runtime = join(fixture.temporary, "wrong-runtime");
    },
    /WINDOW_RUNTIME_MISMATCH/,
  ],
];
for (const mode of ["source-host", "isolated-source-host", "isolated-core-host"]) {
  for (const [name, invalidate, expected] of invalidDeclarations)
    test(`${mode}: ${name} fails before configuration, credentials, environment, process and network effects`, async (t) => {
      const fixture = await sourceWindow(t, mode);
      invalidate(fixture);
      await fixture.refresh();
      const before = await snapshot(fixture.runtime),
        windowBytes = await readFile(fixture.request.file);
      await assertNoEffects(
        fixture,
        fixture.run(mode === "source-host" ? "start.mjs" : "start-isolated-validation.mjs"),
        expected,
        before,
      );
      assert.deepEqual(await readFile(fixture.request.file), windowBytes);
    });
}

test("tampering with the frozen bytes is refused through the same default start CLI", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  await writeFile(fixture.current.freeze.file, "{}");
  await assertNoEffects(
    fixture,
    fixture.run(),
    /WINDOW_FREEZE_DIGEST_MISMATCH/,
    await snapshot(fixture.runtime),
  );
});

for (const mode of ["isolated-source-host", "isolated-core-host"])
  test(`${mode}: a runtime symlink outside the checkout fails before mkdir`, async (t) => {
    const fixture = await sourceWindow(t, mode);
    const outside = join(fixture.temporary, "outside-runtime");
    await mkdir(outside);
    await mkdir(join(fixture.gea, ".runtime"), { recursive: true });
    await symlink(outside, fixture.runtime);
    await assertNoEffects(
      fixture,
      fixture.run("start-isolated-validation.mjs"),
      /WINDOW_RUNTIME_MISMATCH/,
      await snapshot(fixture.runtime),
    );
  });

test("the core-only public function refuses a deployment config before credential and profile actions", async (t) => {
  const fixture = await sourceWindow(t, "isolated-core-host");
  await assertNoEffects(
    fixture,
    fixture.run("runSourceProfile", { config: fixture.configFile }),
    /WINDOW_DEPLOYMENT_MISMATCH/,
    await snapshot(fixture.runtime),
  );
});
test("a changed combination manifest is refused before profile or source-selection writes", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  const file = join(
    fixture.runtime,
    "source-combinations",
    fixture.frozen.combination.id,
    "combination.json",
  );
  await writeFile(file, (await readFile(file, "utf8")) + " ");
  await assertNoEffects(
    fixture,
    fixture.run(),
    /WINDOW_COMBINATION_MISMATCH/,
    await snapshot(fixture.runtime),
  );
});
test("a changed shipped artifact is refused by the existing source-profile reader before launch", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  await writeFile(
    join(
      fixture.runtime,
      "source-combinations",
      fixture.frozen.combination.id,
      "node_modules/dsh-agent-manage/lib/host.js",
    ),
    "changed artifact",
  );
  await assertNoEffects(
    fixture,
    fixture.run(),
    /SOURCE_COMBINATION_DIGEST_MISMATCH/,
    await snapshot(fixture.runtime),
  );
});
test("a changed deployment file is refused before credentials or configuration writes", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  await writeFile(fixture.configFile, "{}");
  await assertNoEffects(
    fixture,
    fixture.run(),
    /WINDOW_CONFIG_DIGEST_MISMATCH/,
    await snapshot(fixture.runtime),
  );
});
test("a normalized deployment mismatch is refused without keychain reads or credentialEnv mutation", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  const config = JSON.parse(await readFile(fixture.configFile, "utf8"));
  config.serviceAccounts = {
    production: {
      clientIdEnv: "GEA_FIXTURE_ID",
      clientSecretEnv: "GEA_FIXTURE_SECRET",
      tenantId: "1",
      allowedUserIds: ["fixture-user"],
      keychainService: "fixture-unavailable-keychain",
    },
  };
  await writeFile(fixture.configFile, JSON.stringify(config));
  fixture.frozen.config.sha256 = hash(await readFile(fixture.configFile));
  await fixture.refresh();
  await assertNoEffects(
    fixture,
    fixture.run(),
    /WINDOW_DEPLOYMENT_MISMATCH/,
    await snapshot(fixture.runtime),
  );
});
test("the public runSourceProfile function also enforces correct freeze and process behavior", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  const result = fixture.run("runSourceProfile");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOCAL_LOOPBACK_FIXTURE_ONLY/);
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.equal(effects.processes.length, 1);
  assert.deepEqual(effects.credentialReads, []);
  assert.deepEqual(effects.network, []);
});
test("an isolated source window rejects frozen five-source tampering before delegated process launch", async (t) => {
  const fixture = await sourceWindow(t, "isolated-source-host");
  await writeFile(fixture.sourcesFile, "[]");
  await assertNoEffects(
    fixture,
    fixture.run("start-isolated-validation.mjs"),
    /WINDOW_SOURCE_DIGEST_MISMATCH/,
    await snapshot(fixture.runtime),
  );
});
test("r7 old filename preparation failure is replayed only in a disposable copy and remains unknown in its original", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  const original = fixture.historicalFailure;
  const originalBytes = await readFile(original),
    oldFailure = JSON.parse(originalBytes);
  assert.match(oldFailure.businessRequests, /unknown/);
  assert.match(oldFailure.modelsAndWrites, /unknown/);
  const copied = join(fixture.temporary, "r7-failure-copy.json");
  await writeFile(copied, originalBytes);
  fixture.frozen.file = "sales27-window-budget-export-r6.json";
  fixture.frozen.priorEvidence = { file: copied, sha256: hash(originalBytes) };
  await fixture.refresh();
  await assertNoEffects(
    fixture,
    fixture.run(),
    /WINDOW_FREEZE_FILE_MISMATCH/,
    await snapshot(fixture.runtime),
  );
  assert.deepEqual(await readFile(original), originalBytes);
  assert.deepEqual(await readFile(copied), originalBytes);
});

test("omitting remaining automatic metadata cannot turn that unknown allowance into a known zero", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  fixture.current.budget.limits.automaticMetadata = 8;
  fixture.frozen.budget.limits.automaticMetadata = 8;
  await fixture.refresh();
  await assertNoEffects(
    fixture,
    fixture.run(),
    /WINDOW_BUDGET_REQUIRED/,
    await snapshot(fixture.runtime),
  );
});
for (const mode of ["source-host", "isolated-source-host", "isolated-core-host"])
  test(`${mode}: omitting the window flag observes zero protected effects at the real CLI`, async (t) => {
    const fixture = await sourceWindow(t, mode);
    fixture.request.file = "";
    await assertNoEffects(
      fixture,
      fixture.run(mode === "source-host" ? "start.mjs" : "start-isolated-validation.mjs"),
      /WINDOW_DECLARATION_REQUIRED/,
      await snapshot(fixture.runtime),
    );
  });

// The existing public function must record the admitted Core before attempting a Host.
test("isolated Core admission records the registered version before a held profile lock", async (t) => {
  const fixture = await sourceWindow(t, "isolated-core-host");
  await mkdir(fixture.runtime, { recursive: true });
  await writeFile(join(fixture.runtime, "source-profile.lock"), "fixture-owned-lock");
  const result = fixture.run("runSourceProfile");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EEXIST/);
  const cli = JSON.parse(await readFile(join(fixture.fixedCore, "apps/cli/package.json"), "utf8"));
  const receipt = JSON.parse(await readFile(join(fixture.runtime, "core-source.json"), "utf8"));
  assert.equal(receipt.version, cli.version);
  assert.equal(receipt.adaptation, JSON.parse(await readFile(fixture.candidateFile, "utf8")).core);
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.deepEqual(effects.processes, []);
  assert.deepEqual(effects.network, []);
});
