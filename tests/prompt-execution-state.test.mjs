import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { PromptExecutionState } from "../src/host/prompt-execution-state.ts";
import {
  checkPromptExecution,
  checkPromptExecutionSource,
} from "../scripts/prompt-execution-check.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "gea-prompt-owner-"));
  let preset = "business-one",
    retired = false;
  const agent = { id: "session" };
  const owner = new PromptExecutionState(
    directory,
    () => {
      if (retired) throw Error("retired Agent must not be queried");
      return preset;
    },
    (value) => value.startsWith("business-"),
  );
  t.after(() => {
    owner.dispose();
    return rm(directory, { recursive: true, force: true });
  });
  return {
    owner,
    agent,
    directory,
    setPreset: (value) => {
      preset = value;
    },
    retire: () => {
      retired = true;
    },
  };
}
const project = (id, alreadyDelivered) => ({
  text: JSON.stringify({ id, alreadyDelivered }),
  receipt: id,
});

test("the host has no second mutable prompt output owner or direct evidence store", async () => {
  assert.deepEqual(await checkPromptExecution(fileURLToPath(new URL("..", import.meta.url))), []);
});
for (const transition of ["turn", "preset", "identity", "dispose"]) {
  test(`a ${transition} invalidates failure, denial, read and catalog effects together`, async (t) => {
    const current = await fixture(t),
      { owner, agent } = current;
    const execution = owner.begin(agent, Symbol());
    if (transition === "turn") owner.startTurn(agent);
    if (transition === "preset") current.setPreset("business-two");
    if (transition === "identity") owner.clear();
    if (transition === "dispose") owner.forget(agent);
    owner.recordOutcome(execution, {
      failure: { key: "old", text: "failed" },
      deniedConsumer: "old",
      read: { key: "old", text: "read" },
      catalog: { fingerprint: "old", reused: true, model: "old", facts: "old" },
    });
    const snapshot = owner.snapshot(agent);
    for (const field of ["failures", "deniedConsumers", "reads", "catalogFacts"])
      assert.equal(snapshot[field].size, 0);
    assert.equal(snapshot.catalogStalls, 0);
  });
}
test("snapshots cannot mutate owned state and another same-turn query does not erase a genuine failure", async (t) => {
  const { owner, agent } = await fixture(t);
  const first = owner.begin(agent, Symbol());
  owner.begin(agent, Symbol());
  owner.recordOutcome(first, {
    failure: { key: "one", text: "blocked" },
    deniedConsumer: "consumer",
  });
  const snapshot = owner.snapshot(agent);
  snapshot.failures.clear();
  snapshot.deniedConsumers.clear();
  snapshot.evidence.push("fake");
  assert.equal(owner.snapshot(agent).failures.get("one"), "blocked");
  assert.ok(owner.snapshot(agent).deniedConsumers.has("consumer"));
  assert.deepEqual(owner.snapshot(agent).evidence, []);
  assert.equal(owner.recordOutcome({}, { failure: { key: "forged", text: "bad" } }), undefined);
  assert.equal(owner.snapshot(agent).failures.has("forged"), false);
});
for (const transition of ["turn", "preset", "identity", "current"]) {
  test(`real persistence crossing ${transition} keeps the original file and publishes only current effects`, async (t) => {
    const current = await fixture(t),
      { owner, agent, directory } = current;
    const execution = owner.begin(agent, Symbol());
    const entered = Promise.withResolvers(),
      resumed = Promise.withResolvers();
    const writeFile = fs.promises.writeFile;
    const intercepted = t.mock.method(fs.promises, "writeFile", async (...args) => {
      if (String(args[0]).endsWith(".txt")) {
        entered.resolve();
        await resumed.promise;
      }
      return writeFile(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      resumed.resolve();
      intercepted.mock.restore();
      syncBuiltinESMExports();
    });
    const pending = owner.publishEvidence(execution, "gea_page", "original", undefined, project);
    const received =
      transition === "identity" ? assert.rejects(pending, /IDENTITY_CHANGED/) : pending;
    await entered.promise;
    if (transition === "turn") owner.startTurn(agent);
    if (transition === "preset") current.setPreset("business-two");
    if (transition === "identity") owner.clear();
    resumed.resolve();
    const result = await received;
    const snapshot = owner.snapshot(agent);
    assert.equal(snapshot.evidence.length, transition === "current" ? 1 : 0);
    assert.equal(snapshot.receipts.size, transition === "current" ? 1 : 0);
    assert.equal(snapshot.returned, transition === "current" ? result.text.length : 0);
    if (transition !== "identity")
      assert.equal(result.kind, transition === "current" ? "published" : "stale-context");
    const original = (await readdir(directory)).find((file) => file.endsWith(".txt"));
    assert.equal(await readFile(join(directory, original), "utf8"), "original");
  });
}
test("both concurrent current successes retain receipts and budget", async (t) => {
  const { owner, agent } = await fixture(t);
  const results = await Promise.all(
    ["first", "second"].map((text) =>
      owner.publishEvidence(owner.begin(agent, Symbol()), "gea_page", text, undefined, project),
    ),
  );
  const snapshot = owner.snapshot(agent);
  assert.equal(snapshot.receipts.size, 2);
  assert.equal(snapshot.evidence.length, 2);
  assert.equal(
    snapshot.returned,
    results.reduce((sum, result) => sum + result.text.length, 0),
  );
});

for (const transition of ["turn", "preset", "identity"]) {
  test(`a stale ${transition} success cannot start persistence`, async (t) => {
    const current = await fixture(t),
      { owner, agent, directory } = current;
    const execution = owner.begin(agent, Symbol());
    if (transition === "turn") owner.startTurn(agent);
    if (transition === "preset") current.setPreset("business-two");
    if (transition === "identity") owner.clear();
    const result = await owner.publishEvidence(execution, "gea_page", "old", undefined, project);
    assert.equal(result.kind, transition === "identity" ? "identity-changed" : "stale-context");
    assert.deepEqual(await readdir(directory), []);
  });
}
for (const transition of ["turn", "preset"]) {
  test(`read authorization crossing ${transition} cannot register a new delivered view`, async (t) => {
    const current = await fixture(t),
      { owner, agent } = current;
    await owner.publishEvidence(
      owner.begin(agent, Symbol()),
      "gea_page",
      "original",
      { owner: "one" },
      project,
    );
    const id = owner.snapshot(agent).evidence[0];
    const entered = Promise.withResolvers(),
      resumed = Promise.withResolvers();
    const render = () => ({ projection: "complete", rows: [{ sku: "one" }] });
    const delivered = { viewId: JSON.stringify, visible: () => true };
    const pending = owner.readEvidence(
      owner.begin(agent, Symbol()),
      agent,
      id,
      undefined,
      undefined,
      async () => {
        entered.resolve();
        await resumed.promise;
      },
      render,
      delivered,
    );
    await entered.promise;
    if (transition === "turn") owner.startTurn(agent);
    else current.setPreset("business-two");
    resumed.resolve();
    const late = await pending;
    assert.ok(late.viewId);
    const execution = owner.begin(agent, Symbol());
    const fresh = await owner.readEvidence(
      execution,
      agent,
      id,
      undefined,
      undefined,
      async () => {},
      render,
      delivered,
    );
    assert.ok(fresh.viewId);
    assert.equal(fresh.projection, "complete");
    const again = await owner.readEvidence(
      execution,
      agent,
      id,
      undefined,
      undefined,
      async () => {},
      render,
      delivered,
    );
    assert.equal(again.projection, "already-delivered");
  });
}

test("the supplementary source check accepts historical names inside comments and strings", () => {
  const source = [
    '// PromptEvidenceStore; new PromptEvidenceStore(); state.failures.set("old", "old")',
    '/* import { PromptEvidenceStore } from "./prompt-evidence.ts"; state.evidence = [] */',
    'const note = "new PromptEvidenceStore(); state.returned += 2";',
    "const history = `PromptEvidenceStore; state.deniedConsumers.add('old')`;",
  ].join("\n");
  assert.deepEqual(checkPromptExecutionSource(source, "src/host/prompt-runtime.ts"), []);
  assert.ok(
    checkPromptExecutionSource(
      'import { PromptEvidenceStore as Store } from "./prompt-evidence.ts"',
      "src/host/new-owner.ts",
    ).length,
  );
});

test("forget retires only the destroyed Agent's pending tokens", async (t) => {
  const { owner, agent } = await fixture(t);
  const destroyedToken = Symbol(),
    otherToken = Symbol();
  const destroyed = owner.begin(agent, destroyedToken);
  const otherAgent = { id: "other-session" };
  const other = owner.begin(otherAgent, otherToken);
  owner.forget(agent);
  assert.equal(owner.execution(destroyedToken), undefined);
  assert.equal(owner.execution(otherToken), other);
  assert.equal(
    (await owner.publishEvidence(destroyed, "gea_page", "old", undefined, project)).kind,
    "stale-context",
  );
});

for (const transition of ["forget", "clear"]) {
  test(`a ${transition} during persistence invalidates effects without reading a retired Agent or creating its state`, async (t) => {
    const current = await fixture(t),
      { owner, agent } = current;
    const execution = owner.begin(agent, Symbol());
    const entered = Promise.withResolvers(),
      resumed = Promise.withResolvers();
    const writeFile = fs.promises.writeFile;
    const intercepted = t.mock.method(fs.promises, "writeFile", async (...args) => {
      if (String(args[0]).endsWith(".txt")) {
        entered.resolve();
        await resumed.promise;
      }
      return writeFile(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      resumed.resolve();
      intercepted.mock.restore();
      syncBuiltinESMExports();
    });
    const completion = owner
      .publishEvidence(execution, "gea_page", "original-retired", undefined, project)
      .catch((error) => error);
    await entered.promise;
    if (transition === "forget") owner.forget(agent);
    else owner.clear();
    current.retire();
    assert.doesNotThrow(() =>
      owner.recordOutcome(execution, {
        failure: { key: "late", text: "late" },
      }),
    );
    resumed.resolve();
    const received = await completion;
    if (transition === "clear") assert.match(received.message, /IDENTITY_CHANGED/);
    else assert.equal(received.kind, "stale-context");
    const publication = await owner.publishEvidence(
      execution,
      "gea_page",
      "late",
      undefined,
      project,
    );
    assert.equal(publication.kind, transition === "clear" ? "identity-changed" : "stale-context");
    const original = (await readdir(current.directory)).find((file) => file.endsWith(".txt"));
    assert.equal(await readFile(join(current.directory, original), "utf8"), "original-retired");
  });
}
