import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { freezeProfileWindow } from "./fixtures/profile-window.mjs";
import { fixtureEnvironment } from "./fixtures/business-session.mjs";
import { spawnSync } from "node:child_process";
import { sourceWindow } from "./fixtures/source-window.mjs";
import { readDeployment } from "../scripts/deployment.mjs";
import { sourcePlugins } from "../scripts/source-composition.mjs";
import { supportedCores } from "../scripts/supported-cores.mjs";

for (const core of supportedCores) {
  test(`a disposable ${core.version} profile freezes its declared Window with zero business allowance`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "gea-profile-window-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const candidate = join(directory, "candidate.json");
    const bytes = JSON.stringify({ core: core.head });
    await writeFile(candidate, bytes);
    fixtureEnvironment(t, { GEA_TEST_CANDIDATE: candidate });
    const result = await freezeProfileWindow({
      directory,
      runtime: resolve(directory, "runtime"),
      caseName: t.name,
      coreOnly: true,
    });
    const request = JSON.parse(await readFile(result.request, "utf8"));
    const window = JSON.parse(await readFile(request.file, "utf8"));
    const frozenBytes = await readFile(window.freeze.file);
    const frozen = JSON.parse(frozenBytes);
    assert.equal(result.core, core.head);
    assert.equal(request.freezeSha256, createHash("sha256").update(frozenBytes).digest("hex"));
    assert.equal(frozen.candidate.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(window.case, t.name);
    assert.equal(window.owner, "local-loopback-test");
    assert.equal(window.status, "open");
    assert.equal(frozen.mode, "isolated-core-host");
    assert.deepEqual(frozen.budget, {
      limits: { hostStarts: 1, businessRequests: 0, modelTasks: 0, businessWrites: 0 },
      remaining: { hostStarts: 1, businessRequests: 0, modelTasks: 0, businessWrites: 0 },
    });
    assert.deepEqual(window.budget, frozen.budget);
    assert.equal((await readdir(directory)).includes("runtime"), false);
  });
}

test("the real profile freeze and launcher reuse the selected source-host combination without re-declaring prepared sources", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  fixtureEnvironment(t, { GEA_TEST_CANDIDATE: fixture.candidateFile });
  const combinationDirectory = join(
    fixture.runtime,
    "source-combinations",
    fixture.frozen.combination.id,
  );
  const metadata = JSON.parse(
    await readFile(join(combinationDirectory, "company-plugins.json"), "utf8"),
  );
  const sources = sourcePlugins.map((plugin) => ({
    repo: plugin.repo,
    source: metadata[plugin.name].source,
    commit: metadata[plugin.name].commit,
    dependencies: join(combinationDirectory, "node_modules", plugin.name, "node_modules"),
  }));
  const sourcesFile = join(fixture.temporary, "prepared-five-sources.json");
  await writeFile(sourcesFile, JSON.stringify(sources));
  const deployment = await readDeployment(fixture.configFile, {
    resolveCredentials: false,
    credentialEnv: {},
  });
  const admitted = await freezeProfileWindow({
    directory: fixture.temporary,
    runtime: fixture.runtime,
    config: fixture.configFile,
    deployment,
    sources,
    caseName: t.name,
    coreOnly: false,
  });
  const declaration = JSON.parse(await readFile(admitted.window.file, "utf8"));
  const frozen = JSON.parse(await readFile(declaration.freeze.file, "utf8"));
  assert.equal(frozen.mode, "source-host");
  assert.deepEqual(frozen.combination, fixture.frozen.combination);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      join(fixture.temporary, "observe-process.mjs"),
      join(fixture.gea, "tests/source-profile-start.mjs"),
      fixture.configFile,
      fixture.runtime,
      "source-host",
      admitted.request,
    ],
    {
      encoding: "utf8",
      timeout: 20000,
      env: { PATH: process.env.PATH, HOME: fixture.temporary, GEA_TEST_SOURCE_INPUTS: sourcesFile },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOCAL_LOOPBACK_FIXTURE_ONLY/);
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.equal(effects.processes.length, 1);
  assert.deepEqual(effects.network, []);
  assert.deepEqual(effects.credentialReads, []);
});

test("a selected source-host Window still rejects explicit sources at the public launcher before effects", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  const result = fixture.run("runSourceProfile", { config: fixture.configFile, sources: [] });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /WINDOW_COMBINATION_MISMATCH/);
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.deepEqual(effects.writes, []);
  assert.deepEqual(effects.processes, []);
  assert.deepEqual(effects.network, []);
  assert.deepEqual(effects.credentialReads, []);
});

test("the real coreOnly launcher preserves its core Window while prepared source inputs remain in the environment", async (t) => {
  const fixture = await sourceWindow(t, "isolated-core-host");
  fixtureEnvironment(t, { GEA_TEST_CANDIDATE: fixture.candidateFile });
  const sourcesFile = join(fixture.temporary, "unused-source-inputs.json");
  await writeFile(sourcesFile, "[]");
  const admitted = await freezeProfileWindow({
    directory: fixture.temporary,
    runtime: fixture.runtime,
    caseName: t.name,
    coreOnly: true,
  });
  const declaration = JSON.parse(await readFile(admitted.window.file, "utf8"));
  const frozen = JSON.parse(await readFile(declaration.freeze.file, "utf8"));
  assert.equal(frozen.mode, "isolated-core-host");
  assert.deepEqual(frozen.combination, { kind: "core" });
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      join(fixture.temporary, "observe-process.mjs"),
      join(fixture.gea, "tests/source-profile-start.mjs"),
      fixture.configFile,
      fixture.runtime,
      "native-only",
      admitted.request,
    ],
    {
      encoding: "utf8",
      timeout: 20000,
      env: { PATH: process.env.PATH, HOME: fixture.temporary, GEA_TEST_SOURCE_INPUTS: sourcesFile },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOCAL_LOOPBACK_FIXTURE_ONLY/);
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.equal(effects.processes.length, 1);
  assert.deepEqual(effects.network, []);
  assert.deepEqual(effects.credentialReads, []);
});
