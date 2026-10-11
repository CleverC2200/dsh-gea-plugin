import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { sourceWindow, snapshot } from "./fixtures/source-window.mjs";

test("a missing window is rejected before reading a deployment or starting a server", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/start.mjs", "--config", "/nonexistent/gea-deployment.json"],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WINDOW_DECLARATION_REQUIRED/);
  assert.doesNotMatch(result.stdout, /dsh web:/);
});

test("an admitted declaration whose deployment disappears fails before profile effects", async (t) => {
  const fixture = await sourceWindow(t, "source-host");
  await unlink(fixture.configFile);
  const before = await snapshot(fixture.runtime);
  const declaration = await readFile(fixture.request.file);
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.ok(result.stderr.includes(fixture.configFile));
  assert.doesNotMatch(result.stdout, /dsh web:|LOCAL_LOOPBACK_FIXTURE_ONLY/);
  const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.deepEqual(effects.writes, []);
  assert.deepEqual(effects.processes, []);
  assert.deepEqual(effects.network, []);
  assert.deepEqual(effects.credentialReads, []);
  assert.deepEqual(effects.credentialEnvReads, []);
  assert.deepEqual(effects.before, effects.after);
  assert.deepEqual(await snapshot(fixture.runtime), before);
  assert.deepEqual(await readFile(fixture.request.file), declaration);
});
