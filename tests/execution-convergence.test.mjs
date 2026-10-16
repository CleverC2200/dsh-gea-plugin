import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptExecutionState } from "../src/host/prompt-execution-state.ts";
import { mountBusinessPrompts } from "../src/host/prompt-runtime.ts";

async function fixture(t) {
  let observedState;
  const snapshot = PromptExecutionState.prototype.snapshot;
  t.mock.method(PromptExecutionState.prototype, "snapshot", function (agent) {
    observedState = snapshot.call(this, agent);
    return observedState;
  });
  const root = await mkdtemp(join(tmpdir(), "gea-execution-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map(),
    registered = new Map();
  let guard,
    assemble,
    identityChanged,
    identity = "one",
    revision = 1,
    preset = "gea-readonly",
    messages = [],
    resourceAdmission = async () => {};
  const names = [
    "skill",
    "skill_reference_read",
    "forecast_compute",
    "mcp__gea-gateway__query_business_data",
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
      deriveMessages: () => messages,
    },
    ctx: { effect: (fn) => fn(), tools: { restrict: () => () => {} } },
  };
  const ctx = {
    tools,
    agents: { get: () => agent, list: () => [agent] },
    sessionProjections: { stateOf: () => preset },
    agentResources: {
      list: async () => {
        await resourceAdmission();
        return [...new Set([preset, "gea-readonly", "gea-html-inventory-aqkc"])].map((id) => ({
          id,
          kind: "prompt",
          installed: true,
          enabled: true,
        }));
      },
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
  t.after(mountBusinessPrompts(ctx, business, { readModules: () => [] }));
  return {
    root,
    state: () => observedState,
    agent,
    setMessages: (value) => {
      messages = value;
    },
    setResourceAdmission: (value) => {
      resourceAdmission = value;
    },
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
    "gea_runtime_diagnose",
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
  assert.deepEqual(result.sections, original.sections);
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
      .execute({ complex: true }, { agent: current.agent, signal: new AbortController().signal }),
  );
  assert.equal("callLimit" in capability, false);
  assert.equal("skills" in capability, false);
  assert.equal("packs" in capability, false);
  assert.equal("loaded" in capability, false);
});

test("business admission survives repeated calls without a turn budget", async (t) => {
  const current = await fixture(t);
  const exec = {
    name: "mcp__gea-gateway__query_business_data",
    agent: current.agent,
    arguments: {},
  };
  for (let i = 0; i < 64; i++) assert.equal(current.guard(exec), undefined);
  assert.equal(current.guard(exec), undefined);
  current.setPreset("agent-resource-skill");
  assert.match(current.guard(exec), /GEA_BUSINESS_PROFILE_REQUIRED/);
  assert.equal(current.guard({ ...exec, name: "skill" }), undefined);
});

for (const transition of ["turn", "identity", "preset"]) {
  test(`late permission failure remains the original result after ${transition} without blocking current reads`, async (t) => {
    const current = await fixture(t);
    const exec = {
      name: "mcp__gea-gateway__query_business_data",
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
      content: [{ type: "text", text: '{"availability":"permission-required"}' }],
    };
    const decision = { kind: "accept" };
    assert.equal(
      await current.handlers.get("tools/post-execute")(exec, result, async () => decision),
      decision,
    );
    await current.assemble({ sections: [], tools: [] });
    assert.equal(current.state().failures.size > 0, false);
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

test("current permission failure remains visible across concurrent current MCP queries", async (t) => {
  const current = await fixture(t);
  const exec = {
    name: "mcp__gea-gateway__query_business_data",
    token: Symbol(),
    agent: current.agent,
    arguments: {},
    signal: new AbortController().signal,
  };
  await current.handlers.get("tools/execute")(exec, async () => {});
  await current.handlers.get("tools/execute")({ ...exec, token: Symbol() }, async () => {});
  await current.handlers.get("tools/post-execute")(
    exec,
    {
      isError: true,
      content: [{ type: "text", text: '{"availability":"permission-required"}' }],
    },
    async () => ({ kind: "accept" }),
  );
  await current.assemble({ sections: [], tools: [] });
  assert.equal(current.state().failures.size > 0, true);
  assert.equal(current.guard({ ...exec, token: Symbol(), arguments: {} }), undefined);
  // Current native tools derive Consumer in GEA; caller-supplied identity is rejected by the registered-tool tests.
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
  const { resultChars } = await promptState(t, current);
  assert.equal(current.state().evidence.length > 0 || current.state().receipts.size > 0, false);
  assert.equal(resultChars, 0);
  assert.equal(received, decision);
});

function pauseEvidenceWrite(t, root) {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const writeFile = fs.promises.writeFile;
  const intercepted = t.mock.method(fs.promises, "writeFile", async (...args) => {
    if (
      String(args[0]).startsWith(join(root, "prompt-evidence")) &&
      String(args[0]).endsWith(".txt")
    ) {
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
  const pending = current.handlers.get("tools/post-execute")(exec, result, async () => decision);
  await writing.entered;
  current.nextTurn();
  writing.resume();
  const received = await pending;
  const { resultChars } = await promptState(t, current);
  assert.equal(current.state().evidence.length > 0 || current.state().receipts.size > 0, false);
  assert.equal(resultChars, 0);
  assert.equal(received, decision);
  const files = await readdir(join(current.root, "prompt-evidence"));
  const original = files.find((file) => file.endsWith(".txt"));
  assert.ok(original);
  assert.equal(await readFile(join(current.root, "prompt-evidence", original), "utf8"), text);
});

async function promptState(t, current) {
  let measurement;
  const info = t.mock.method(console, "info", (entry) => {
    measurement = JSON.parse(entry);
  });
  const assembled = await current.assemble({ sections: [], tools: [] });
  info.mock.restore();
  assert.equal(measurement.event, "GEA_PROMPT_BUDGET");
  return {
    assembled,
    resultChars: measurement.resultChars,
  };
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
      content: [{ type: "text", text: '{"status":"completed","value":{"old":true}}' }],
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
    const { resultChars } = await promptState(t, current);
    assert.equal(current.state().evidence.length > 0 || current.state().receipts.size > 0, false);
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
    const pending = current.handlers.get("tools/post-execute")(exec, result, async () => decision);
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
    const { resultChars } = await promptState(t, current);
    const index = current.state().evidence.join(",");
    if (transition === "current") {
      assert.equal(accepted.kind, "accept");
      assert.equal(accepted.content[0].text, text);
      assert.match(index, /ev-[a-f0-9]{24}/);
      assert.match([...current.state().receipts.values()].join("\n"), /gea_sales_plan_read/);
      assert.equal(resultChars, text.length);
    } else {
      if (transition === "preset") assert.equal(accepted, decision);
      assert.equal(index, "");
      assert.equal(current.state().receipts.size > 0, false);
      assert.equal(resultChars, 0);
    }
    const files = await readdir(join(current.root, "prompt-evidence"));
    const original = files.find((file) => file.endsWith(".txt"));
    assert.ok(original);
    assert.equal(await readFile(join(current.root, "prompt-evidence", original), "utf8"), text);
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
  const returned = await Promise.all([finish(first, firstText), finish(second, secondText)]);
  assert.deepEqual(
    returned.map((result) => result.content[0].text),
    [firstText, secondText],
  );
  const { resultChars } = await promptState(t, current);
  const index = current.state().evidence.join(",");
  const ids = index.match(/ev-[a-f0-9]{24}/g);
  assert.equal(new Set(ids).size, 2);
  const receipts = [...current.state().receipts.values()].join("\n");
  for (const id of ids) assert.ok(receipts.includes(id));
  assert.equal(resultChars, firstText.length + secondText.length);
});

for (const transition of ["turn", "preset", "identity"]) {
  test(`resource admission crossing ${transition} cannot acquire the new execution owner`, async (t) => {
    const current = await fixture(t);
    const entered = Promise.withResolvers(),
      resumed = Promise.withResolvers();
    current.setResourceAdmission(async () => {
      entered.resolve();
      await resumed.promise;
    });
    const exec = {
      name: "gea_sales_plan_read",
      token: Symbol(),
      agent: current.agent,
      arguments: {},
      signal: new AbortController().signal,
    };
    const admission = current.handlers.get("tools/execute")(exec, async () => {});
    await entered.promise;
    if (transition === "turn") current.nextTurn();
    if (transition === "preset") current.setPreset("gea-html-inventory-aqkc");
    if (transition === "identity") current.changeIdentity();
    resumed.resolve();
    await admission;
    const decision = { kind: "accept" };
    const received = await current.handlers.get("tools/post-execute")(
      exec,
      {
        content: [{ type: "text", text: '{"status":"completed","value":{"old":true}}' }],
      },
      async () => decision,
    );
    if (transition === "identity") assert.equal(received.kind, "block");
    else assert.equal(received, decision);
    const { resultChars } = await promptState(t, current);
    assert.equal(current.state().evidence.join(","), "");
    assert.equal(resultChars, 0);
  });
}

for (const transition of ["preset", "turn", "current"]) {
  test(`evidence read crossing ${transition} during real file IO preserves its projection and registers only current views`, async (t) => {
    const current = await fixture(t);
    const exec = {
      name: "gea_page",
      token: Symbol(),
      agent: current.agent,
      arguments: {},
      signal: new AbortController().signal,
    };
    await current.handlers.get("tools/execute")(exec, async () => {});
    await current.handlers.get("tools/post-execute")(
      exec,
      {
        content: [
          {
            type: "text",
            text: '{"status":"completed","value":{"rows":[{"sku":"old"}]}}',
          },
        ],
      },
      async () => ({ kind: "accept" }),
    );
    await promptState(t, current);
    const id = current
      .state()
      .evidence.join(",")
      .match(/ev-[a-f0-9]{24}/)[0];
    const entered = Promise.withResolvers(),
      resumed = Promise.withResolvers();
    const readFile = fs.promises.readFile;
    const intercepted = t.mock.method(fs.promises, "readFile", async (...args) => {
      if (String(args[0]) === join(current.root, "prompt-evidence", id + ".txt")) {
        entered.resolve();
        await resumed.promise;
      }
      return readFile(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      resumed.resolve();
      intercepted.mock.restore();
      syncBuiltinESMExports();
    });
    const readExec = { ...exec, name: "gea_evidence_read", token: Symbol() };
    await current.handlers.get("tools/execute")(readExec, async () => {});
    const pending = current.registered
      .get("gea_evidence_read")
      .execute({ evidenceId: id }, readExec);
    await entered.promise;
    if (transition === "preset") current.setPreset("gea-html-inventory-aqkc");
    if (transition === "turn") current.nextTurn();
    resumed.resolve();
    const late = JSON.parse(await pending);
    assert.ok(late.viewId);
    current.setMessages([{ viewId: late.viewId }]);
    intercepted.mock.restore();
    syncBuiltinESMExports();
    const freshExec = { ...readExec, token: Symbol() };
    await current.handlers.get("tools/execute")(freshExec, async () => {});
    if (transition === "turn") {
      await assert.rejects(
        current.registered.get("gea_evidence_read").execute({ evidenceId: id }, freshExec),
        /GEA_EVIDENCE_STALE/,
      );
      const { resultChars } = await promptState(t, current);
      assert.equal(current.state().evidence.join(","), "");
      assert.equal(resultChars, 0);
      return;
    }
    const fresh = JSON.parse(
      await current.registered.get("gea_evidence_read").execute({ evidenceId: id }, freshExec),
    );
    if (transition === "current") {
      assert.equal(fresh.projection, "already-delivered");
      const characters = JSON.parse(
        await current.registered
          .get("gea_evidence_read")
          .execute({ evidenceId: id, offset: 0, limit: 10 }, freshExec),
      );
      assert.equal(characters.content.length, 10);
      assert.equal(characters.viewId, undefined);
      return;
    }
    assert.ok(fresh.viewId);
    assert.notEqual(fresh.projection, "already-delivered");
    current.setMessages([{ viewId: fresh.viewId }]);
    const again = JSON.parse(
      await current.registered.get("gea_evidence_read").execute({ evidenceId: id }, freshExec),
    );
    assert.equal(again.projection, "already-delivered");
  });
}

test("a query rejected during resource admission does not reopen stalled catalog discovery", async (t) => {
  const current = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const catalog = {
      name: "mcp__gea-gateway__inspect_cube_model",
      token: Symbol(),
      agent: current.agent,
      arguments: {},
      signal: new AbortController().signal,
    };
    await current.handlers.get("tools/execute")(catalog, async () => {});
    await current.handlers.get("tools/post-execute")(
      catalog,
      { content: [{ type: "text", text: '{"source":"GEA_CATALOG_REUSED"}' }] },
      async () => ({ kind: "accept" }),
    );
  }
  const query = {
    name: "mcp__gea-gateway__query_business_data",
    token: Symbol(),
    agent: current.agent,
    arguments: {},
    signal: new AbortController().signal,
  };
  current.setResourceAdmission(async () => {
    throw Error("resource-admission-denied");
  });
  await assert.rejects(
    current.handlers.get("tools/execute")(query, async () => {}),
    /resource-admission-denied/,
  );
  assert.equal(
    current.guard({ ...query, name: "mcp__gea-gateway__inspect_cube_model" }),
    undefined,
  );
});

for (const phase of ["admission", "downstream"]) {
  test(`a ${phase} pipeline error keeps the original error and retires execution metadata without a post hook`, async (t) => {
    const current = await fixture(t);
    const error = new Error("original-pipeline-error");
    const exec = {
      name: "gea_sales_plan_read",
      token: Symbol(),
      agent: current.agent,
      arguments: {},
      signal: new AbortController().signal,
    };
    assert.equal(current.guard(exec), undefined);
    if (phase === "admission")
      current.setResourceAdmission(async () => {
        throw error;
      });
    await assert.rejects(
      current.handlers.get("tools/execute")(exec, async () => {
        throw error;
      }),
      (received) => received === error,
    );
    // Official around-dispatch errors skip post-execute. Even an accidental later hook cannot resurrect this token.
    const decision = { kind: "accept" };
    const received = await current.handlers.get("tools/post-execute")(
      exec,
      {
        content: [
          {
            type: "text",
            text: '{"status":"completed","value":{"late":true}}',
          },
        ],
      },
      async () => decision,
    );
    assert.equal(received, decision);
    const { resultChars } = await promptState(t, current);
    assert.equal(current.state().evidence.join(","), "");
    assert.equal(resultChars, 0);
  });
}

test("a post policy error preserves the original error and retires metadata before another policy awaits", async (t) => {
  const current = await fixture(t);
  const exec = {
    name: "gea_sales_plan_read",
    token: Symbol(),
    agent: current.agent,
    arguments: {},
    signal: new AbortController().signal,
  };
  assert.equal(current.guard(exec), undefined);
  await current.handlers.get("tools/execute")(exec, async () => {});
  const error = new TypeError("original-post-policy-error");
  const result = {
    content: [{ type: "text", text: '{"status":"completed","value":{"late":true}}' }],
  };
  await assert.rejects(
    current.handlers.get("tools/post-execute")(exec, result, async () => {
      throw error;
    }),
    (received) => received === error,
  );
  const decision = { kind: "accept" };
  assert.equal(
    await current.handlers.get("tools/post-execute")(exec, result, async () => decision),
    decision,
  );
  const { resultChars } = await promptState(t, current);
  assert.equal(current.state().evidence.join(","), "");
  assert.equal(resultChars, 0);
});
