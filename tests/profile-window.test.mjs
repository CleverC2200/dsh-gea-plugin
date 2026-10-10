import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { freezeProfileWindow } from "./fixtures/profile-window.mjs";
import { fixtureEnvironment } from "./fixtures/business-session.mjs";
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
