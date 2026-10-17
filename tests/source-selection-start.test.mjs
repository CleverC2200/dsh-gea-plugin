import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sourceWindow, snapshot } from "./fixtures/source-window.mjs";

for (const entry of ["start.mjs", "runSourceProfile"])
  test(`${entry}: a selected startup completes one full snapshot traversal under its stopped-profile lock`, async (t) => {
    const fixture = await sourceWindow(t, "source-host");
    const result = fixture.run(entry);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /LOCAL_LOOPBACK_FIXTURE_ONLY/);
    const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
    assert.deepEqual(effects.traversals, [
      {
        path: await realpath(
          join(fixture.runtime, "source-combinations", fixture.frozen.combination.id),
        ),
        locked: true,
      },
    ]);
  });

for (const change of ["window", "selection", "asset"])
  test(`startup refuses a ${change} change while acquiring the stopped-profile lock`, async (t) => {
    const fixture = await sourceWindow(t, "source-host");
    let file, contents, expected;
    if (change === "window") {
      file = fixture.request.file;
      contents = JSON.stringify({ ...fixture.current, status: "closed" });
      expected = /WINDOW_NOT_OPEN/;
    } else if (change === "selection") {
      file = join(fixture.runtime, "source-selection.json");
      contents = JSON.stringify({ id: "0".repeat(36), manifestSha256: "0".repeat(64) });
      expected = /WINDOW_COMBINATION_MISMATCH/;
    } else {
      file = join(
        fixture.runtime,
        "source-combinations",
        fixture.frozen.combination.id,
        "node_modules/@cleverc2200/dsh-agent-workbench/lib/host.js",
      );
      contents = "changed while acquiring lock";
      expected = /SOURCE_COMBINATION_DIGEST_MISMATCH/;
    }
    const result = fixture.run(
      "runSourceProfile",
      {},
      {
        GEA_FIXTURE_LOCK_CHANGE: JSON.stringify({ file, contents }),
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected);
    const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
    assert.deepEqual(effects.processes, []);
    assert.deepEqual(effects.credentialReads, []);
    assert.deepEqual(effects.after, effects.before);
    await assert.rejects(access(join(fixture.runtime, "home")), { code: "ENOENT" });
    await assert.rejects(access(join(fixture.runtime, "source-profile.lock")), { code: "ENOENT" });
  });

test("the isolated source CLI leaves the frozen snapshot's complete verification to its locked child startup", async (t) => {
  const fixture = await sourceWindow(t, "isolated-source-host");
  const result = fixture.run("start-isolated-validation.mjs", [], { GEA_FIXTURE_DELEGATE: "1" });
  const parent = JSON.parse(await readFile(fixture.observation, "utf8"));
  assert.deepEqual(parent.traversals, []);
  if (process.platform !== "darwin") {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ISOLATED_VALIDATION_REQUIRES_MACOS_SANDBOX/);
    assert.deepEqual(parent.processes, []);
    return;
  }
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /LOCAL_LOOPBACK_FIXTURE_ONLY/);
  assert.equal(parent.processes[0].command, "/usr/bin/sandbox-exec");
  const child = JSON.parse(await readFile(fixture.observation + ".child", "utf8"));
  const snapshot = await realpath(
    join(
      fixture.frozen.combination.snapshot.runtime,
      "source-combinations",
      fixture.frozen.combination.snapshot.id,
    ),
  );
  assert.deepEqual(
    child.traversals.filter(({ path }) => path === snapshot),
    [{ path: snapshot, locked: true }],
  );
  assert.equal(child.processes.length, 1);
  assert.deepEqual(parent.network, []);
  assert.deepEqual(child.network, []);
});

test("startup rejects incomplete selection digests and manifest-only changes before launching a Host", async (t) => {
  for (const kind of ["missing", "empty", "null", "manifest-changed"]) {
    await t.test(kind, async (t) => {
      const fixture = await sourceWindow(t, "source-host");
      const file = join(fixture.runtime, "source-selection.json");
      const selected = JSON.parse(await readFile(file, "utf8"));
      if (kind === "missing") delete selected.manifestSha256;
      if (kind === "empty") selected.manifestSha256 = "";
      await writeFile(file, JSON.stringify(kind === "null" ? null : selected));
      if (kind === "manifest-changed") {
        const manifest = join(
          fixture.runtime,
          "source-combinations",
          selected.id,
          "combination.json",
        );
        await writeFile(manifest, (await readFile(manifest, "utf8")) + " ");
      }
      await writeFile(join(fixture.runtime, "user-data.txt"), "keep user data");
      const before = await snapshot(fixture.runtime),
        result = fixture.run("runSourceProfile");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /SOURCE_SELECTION_DIGEST_MISMATCH|WINDOW_COMBINATION_MISMATCH/);
      assert.deepEqual(await snapshot(fixture.runtime), before);
      const effects = JSON.parse(await readFile(fixture.observation, "utf8"));
      assert.deepEqual(effects.writes, []);
      assert.deepEqual(effects.processes, []);
      assert.deepEqual(effects.network, []);
      assert.deepEqual(effects.credentialReads, []);
      assert.deepEqual(effects.after, effects.before);
    });
  }
});
