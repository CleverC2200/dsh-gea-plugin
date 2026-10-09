import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountBusinessPrompts } from "../src/host/prompt-runtime.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-execution-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map(),
    registered = new Map();
  let guard,
    assemble,
    identityChanged,
    identity = "one",
    revision = 1,
    preset = "gea-readonly";
  const names = [
    "skill",
    "skill_reference_read",
    "forecast_compute",
    "gea_cube_query",
    "gea_capabilities",
    "gea_evidence_read",
  ];
  const tools = {
    register: (tool) => {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
    guard: (fn) => {
      guard = fn;
      return () => {};
    },
    schemas: () => names.map((name) => ({ name })),
    get: (name) => (names.includes(name) ? { name } : undefined),
  };
  const agent = {
    id: "actual-scope",
    session: {
      header: { cwd: "/project" },
      snapshotEvents: () => [],
      deriveMessages: () => [],
    },
    ctx: { effect: (fn) => fn(), tools: { restrict: () => () => {} } },
  };
  const ctx = {
    tools,
    agents: { get: () => agent },
    sessionProjections: { stateOf: () => preset },
    agentResources: {
      list: async () => [
        { id: preset, kind: "prompt", installed: true, enabled: true },
      ],
    },
    skills: {
      list: async () => {
        throw Error("GEA must not load catalog");
      },
      get: async () => {
        throw Error("GEA must not load body");
      },
    },
    on: (name, fn) => {
      handlers.set(name, fn);
      return () => {};
    },
    inject: (names, fn) =>
      fn({
        on: (_name, callback) => {
          assemble = callback;
        },
      }),
  };
  const business = {
    config: { runtimeDir: root, analysisAgentCode: "sales" },
    status: () => ({ source: "test", user: { id: identity } }),
    watchIdentity: (fn) => {
      identityChanged = fn;
      return () => {};
    },
    readTurnRevision: () => revision,
    surfaceFor: () => undefined,
    turnStopKind: () => undefined,
  };
  t.after(
    mountBusinessPrompts(ctx, business, { readModules: () => [] }, new Map()),
  );
  return {
    root,
    agent,
    handlers,
    registered,
    guard: (exec) => guard(exec),
    assemble: (assembled) => assemble({}, { agent }, async () => assembled),
    setPreset: (value) => {
      preset = value;
    },
    nextTurn: () => {
      revision++;
      handlers.get("session/event")({ id: agent.id }, { type: "turn/start" });
    },
    changeIdentity: () => {
      identity = "two";
      identityChanged();
    },
  };
}

test("GEA registers execution metadata and evidence only, preserving the original official Skill and persona assembly", async (t) => {
  const current = await fixture(t);
  assert.deepEqual([...current.registered.keys()].sort(), [
    "gea_capabilities",
    "gea_evidence_read",
  ]);
  const original = {
    sections: [
      { name: "skill:catalog", text: "Exact original catalog" },
      { name: "deployment:persona-prefix", text: "Exact source persona" },
      { name: "platform:security", text: "Exact platform rule" },
    ],
    tools: [{ name: "skill", description: "Official full-body loader" }],
  };
  const result = await current.assemble(original);
  for (const section of original.sections)
    assert.ok(result.sections.includes(section));
  assert.equal(
    result.tools.find((tool) => tool.name === "skill").description,
    "Official full-body loader",
  );
  assert.equal(
    result.sections.some((section) => section.name === "gea:capabilities"),
    false,
  );
  const capability = JSON.parse(
    await current.registered
      .get("gea_capabilities")
      .execute(
        { complex: true },
        { agent: current.agent, signal: new AbortController().signal },
      ),
  );
  assert.equal(capability.callLimit, 40);
  assert.equal("skills" in capability, false);
  assert.equal("packs" in capability, false);
  assert.equal("loaded" in capability, false);
});

test("business admission and concurrent budget reservations survive resource orchestration removal", async (t) => {
  const current = await fixture(t);
  const exec = { name: "gea_cube_query", agent: current.agent, arguments: {} };
  for (let i = 0; i < 20; i++) assert.equal(current.guard(exec), undefined);
  assert.match(current.guard(exec), /GEA_CALL_BUDGET/);
  current.setPreset("agent-resource-skill");
  assert.match(current.guard(exec), /GEA_BUSINESS_PROFILE_REQUIRED/);
  assert.equal(current.guard({ ...exec, name: "skill" }), undefined);
});

for (const transition of ["turn", "identity", "preset"]) {
  test(`late permission failure remains the original result after ${transition} without blocking current reads`, async (t) => {
    const current = await fixture(t);
    const exec = {
      name: "gea_cube_query",
      token: Symbol(),
      agent: current.agent,
      arguments: {},
      signal: new AbortController().signal,
    };
    await current.handlers.get("tools/execute")(exec, async () => {});
    if (transition === "turn") current.nextTurn();
    if (transition === "identity") current.changeIdentity();
    if (transition === "preset") current.setPreset("gea-html-inventory-aqkc");
    const result = {
      isError: true,
      content: [
        { type: "text", text: '{"availability":"permission-required"}' },
      ],
    };
    const decision = { kind: "accept" };
    assert.equal(
      await current.handlers.get("tools/post-execute")(
        exec,
        result,
        async () => decision,
      ),
      decision,
    );
    const assembled = await current.assemble({ sections: [], tools: [] });
    assert.equal(
      assembled.sections.some((s) => s.name === "gea:read-gaps"),
      false,
    );
    assert.equal(
      current.guard({
        ...exec,
        token: Symbol(),
        arguments: { consumerCode: "another-registered-consumer" },
      }),
      undefined,
    );
  });
}

test("current permission failure remains visible across concurrent queries and prevents Consumer fallback", async (t) => {
  const current = await fixture(t);
  const exec = {
    name: "gea_cube_query",
    token: Symbol(),
    agent: current.agent,
    arguments: {},
    signal: new AbortController().signal,
  };
  await current.handlers.get("tools/execute")(exec, async () => {});
  await current.handlers.get("tools/execute")(
    { ...exec, token: Symbol() },
    async () => {},
  );
  await current.handlers.get("tools/post-execute")(
    exec,
    {
      isError: true,
      content: [
        { type: "text", text: '{"availability":"permission-required"}' },
      ],
    },
    async () => ({ kind: "accept" }),
  );
  const assembled = await current.assemble({ sections: [], tools: [] });
  assert.equal(
    assembled.sections.some((s) => s.name === "gea:read-gaps"),
    true,
  );
  assert.match(
    current.guard({
      ...exec,
      token: Symbol(),
      arguments: { consumerCode: "another-registered-consumer" },
    }),
    /GEA_CONSUMER_FALLBACK_DENIED/,
  );
});

test("late successful read after a new turn preserves its original result without entering current evidence", async (t) => {
  const current = await fixture(t);
  const exec = {
    name: "gea_sales_plan_read",
    token: Symbol(),
    agent: current.agent,
    arguments: { period: "old-turn" },
    signal: new AbortController().signal,
  };
  await current.handlers.get("tools/execute")(exec, async () => {});
  current.nextTurn();
  const result = {
    content: [
      {
        type: "text",
        text: '{"status":"completed","value":{"period":"old-turn"}}',
      },
    ],
  };
  const decision = { kind: "accept" };
  const received = await current.handlers.get("tools/post-execute")(
    exec,
    result,
    async () => decision,
  );
  const { assembled, resultChars } = await promptState(t, current);
  assert.equal(
    assembled.sections.some(
      (s) =>
        ["gea:evidence-index", "gea:result-status"].includes(s.name) && s.text,
    ),
    false,
  );
  assert.equal(resultChars, 0);
  assert.equal(received, decision);
});

function pauseEvidenceWrite(t, root) {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const writeFile = fs.promises.writeFile;
  const intercepted = t.mock.method(
    fs.promises,
    "writeFile",
    async (...args) => {
      if (
        String(args[0]).startsWith(join(root, "prompt-evidence")) &&
        String(args[0]).endsWith(".txt")
      ) {
        entered.resolve();
        await resumed.promise;
      }
      return writeFile(...args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    resumed.resolve();
    intercepted.mock.restore();
    syncBuiltinESMExports();
  });
  return { entered: entered.promise, resume: resumed.resolve };
}

test("a successful read crossing a turn during evidence persistence keeps its original file without entering current evidence", async (t) => {
  const current = await fixture(t);
  const exec = {
    name: "gea_sales_plan_read",
    token: Symbol(),
    agent: current.agent,
    arguments: { period: "old-write" },
    signal: new AbortController().signal,
  };
  await current.handlers.get("tools/execute")(exec, async () => {});
  const writing = pauseEvidenceWrite(t, current.root);
  const text = '{"status":"completed","value":{"period":"old-write"}}';
  const result = { content: [{ type: "text", text }] };
  const decision = { kind: "accept" };
  const pending = current.handlers.get("tools/post-execute")(
    exec,
    result,
    async () => decision,
  );
  await writing.entered;
  current.nextTurn();
  writing.resume();
  const received = await pending;
  const { assembled, resultChars } = await promptState(t, current);
  assert.equal(
    assembled.sections.some(
      (s) =>
        ["gea:evidence-index", "gea:result-status"].includes(s.name) && s.text,
    ),
    false,
  );
  assert.equal(resultChars, 0);
  assert.equal(received, decision);
  const files = await readdir(join(current.root, "prompt-evidence"));
  const original = files.find((file) => file.endsWith(".txt"));
  assert.ok(original);
  assert.equal(
    await readFile(join(current.root, "prompt-evidence", original), "utf8"),
    text,
  );
});

async function promptState(t, current) {
  let measurement;
  const info = t.mock.method(console, "info", (entry) => {
    measurement = JSON.parse(entry);
  });
  const assembled = await current.assemble({ sections: [], tools: [] });
  info.mock.restore();
  assert.equal(measurement.event, "GEA_PROMPT_BUDGET");
  return { assembled, resultChars: measurement.resultChars };
}

for (const transition of ["preset", "identity"]) {
  test(`late successful read after ${transition} keeps the current evidence empty`, async (t) => {
    const current = await fixture(t);
    const exec = {
      name: "gea_sales_plan_read",
      token: Symbol(),
      agent: current.agent,
      arguments: { period: "old-" + transition },
      signal: new AbortController().signal,
    };
    await current.handlers.get("tools/execute")(exec, async () => {});
    if (transition === "preset") current.setPreset("gea-html-inventory-aqkc");
    else current.changeIdentity();
    const result = {
      content: [
        { type: "text", text: '{"status":"completed","value":{"old":true}}' },
      ],
    };
    const decision = { kind: "accept" };
    const received = await current.handlers.get("tools/post-execute")(
      exec,
      result,
      async () => decision,
    );
    if (transition === "preset") assert.equal(received, decision);
    else {
      assert.equal(received.kind, "block");
      assert.match(received.feedback[0].text, /GEA_EVIDENCE_IDENTITY_CHANGED/);
    }
    const { assembled, resultChars } = await promptState(t, current);
    assert.equal(
      assembled.sections.some(
        (s) =>
          ["gea:evidence-index", "gea:result-status"].includes(s.name) &&
          s.text,
      ),
      false,
    );
    assert.equal(resultChars, 0);
  });
}

for (const transition of ["preset", "identity", "current"]) {
  test(`successful evidence persistence during ${transition} preserves the file and respects current context`, async (t) => {
    const current = await fixture(t);
    const exec = {
      name: "gea_sales_plan_read",
      token: Symbol(),
      agent: current.agent,
      arguments: { period: transition },
      signal: new AbortController().signal,
    };
    await current.handlers.get("tools/execute")(exec, async () => {});
    const writing = pauseEvidenceWrite(t, current.root);
    const text = JSON.stringify({
      status: "completed",
      value: { period: transition },
    });
    const result = { content: [{ type: "text", text }] };
    const decision = { kind: "accept" };
    const pending = current.handlers.get("tools/post-execute")(
      exec,
      result,
      async () => decision,
    );
    // Attach the expected identity rejection before releasing the real file write.
    const received =
      transition === "identity"
        ? assert.rejects(pending, /GEA_EVIDENCE_IDENTITY_CHANGED/)
        : pending;
    await writing.entered;
    if (transition === "preset") current.setPreset("gea-html-inventory-aqkc");
    if (transition === "identity") current.changeIdentity();
    writing.resume();
    const accepted = await received;
    const { assembled, resultChars } = await promptState(t, current);
    const index = assembled.sections.find(
      (s) => s.name === "gea:evidence-index",
    ).text;
    if (transition === "current") {
      assert.equal(accepted.kind, "accept");
      assert.equal(accepted.content[0].text, text);
      assert.match(index, /ev-[a-f0-9]{24}/);
      assert.match(
        assembled.sections.find((s) => s.name === "gea:result-status").text,
        /gea_sales_plan_read/,
      );
      assert.equal(resultChars, text.length);
    } else {
      if (transition === "preset") assert.equal(accepted, decision);
      assert.equal(index, "");
      assert.equal(
        assembled.sections.some((s) => s.name === "gea:result-status"),
        false,
      );
      assert.equal(resultChars, 0);
    }
    const files = await readdir(join(current.root, "prompt-evidence"));
    const original = files.find((file) => file.endsWith(".txt"));
    assert.ok(original);
    assert.equal(
      await readFile(join(current.root, "prompt-evidence", original), "utf8"),
      text,
    );
  });
}

test("two successful reads in the same turn both retain their receipts and result budget", async (t) => {
  const current = await fixture(t);
  const first = {
    name: "gea_sales_plan_read",
    token: Symbol(),
    agent: current.agent,
    arguments: { period: "first" },
    signal: new AbortController().signal,
  };
  const second = { ...first, token: Symbol(), arguments: { period: "second" } };
  await current.handlers.get("tools/execute")(first, async () => {});
  await current.handlers.get("tools/execute")(second, async () => {});
  const firstText = '{"status":"completed","value":{"period":"first"}}';
  const secondText = '{"status":"completed","value":{"period":"second"}}';
  const finish = (exec, text) =>
    current.handlers.get("tools/post-execute")(
      exec,
      { content: [{ type: "text", text }] },
      async () => ({ kind: "accept" }),
    );
  const returned = await Promise.all([
    finish(first, firstText),
    finish(second, secondText),
  ]);
  assert.deepEqual(
    returned.map((result) => result.content[0].text),
    [firstText, secondText],
  );
  const { assembled, resultChars } = await promptState(t, current);
  const index = assembled.sections.find(
    (s) => s.name === "gea:evidence-index",
  ).text;
  const ids = index.match(/ev-[a-f0-9]{24}/g);
  assert.equal(new Set(ids).size, 2);
  const receipts = assembled.sections.find(
    (s) => s.name === "gea:result-status",
  ).text;
  for (const id of ids) assert.ok(receipts.includes(id));
  assert.equal(resultChars, firstText.length + secondText.length);
});
