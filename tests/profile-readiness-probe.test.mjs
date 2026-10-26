import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readProfileReadinessSnapshot,
  installProfileReadinessProbe,
  apply,
} from "./fixtures/profile-readiness-probe.mjs";

function context() {
  const secret = "DO_NOT_CAPTURE_PROFILE_SECRET";
  const root = { uid: 0, runtime: null };
  root.parent = { fiber: root };
  const service = {
    token: secret,
    toJSON() {
      throw Error("SERVICE_SERIALIZED");
    },
  };
  const get = (name) =>
    ["loader", "agentPresets", "skills", "commands", "connection", "tools"].includes(name)
      ? service
      : undefined;
  const manage = {
    uid: 1,
    runtime: { name: "dsh-agent-manage" },
    state: 2,
    inject: { skills: {}, commands: {} },
    parent: { fiber: root },
    config: { secret },
    ctx: { get },
  };
  const loading = {
    uid: 2,
    runtime: {},
    state: 1,
    inject: { agentPresets: { secret }, loader: {} },
    parent: { fiber: manage },
    inertia: new Proxy(Promise.resolve(), {
      get(target, key) {
        if (key === "then") throw Error("FIBER_AWAITED");
        return Reflect.get(target, key);
      },
    }),
    ctx: { get },
  };
  const pending = {
    uid: 3,
    runtime: {},
    state: 0,
    inject: { agentPresets: {}, connection: {}, tools: {}, agents: {} },
    parent: { fiber: manage },
    ctx: { get },
  };
  const effects = [];
  return {
    get,
    registry: { values: () => [{ fibers: [manage] }, { fibers: [loading, pending] }] },
    loader: {
      entries: () => [
        {
          options: { name: "@deepseek-ai/dsh-agent-preset", config: { id: "standard", secret } },
          fiber: loading,
          disabled: false,
        },
      ],
    },
    effect: (fn) => effects.push(fn()),
    effects,
    logger: { warn() {} },
    secret,
  };
}

test("profile diagnostics read pending dependencies without awaiting or serializing configuration and services", () => {
  const ctx = context();
  const snapshot = readProfileReadinessSnapshot(ctx);
  assert.equal(snapshot.services.userAgents, false);
  assert.equal(snapshot.services.agentResources, false);
  assert.deepEqual(
    snapshot.fibers.map((row) => row.uid),
    [1, 2, 3],
  );
  assert.equal(snapshot.fibers[1].inertia, true);
  assert.equal(snapshot.fibers[2].services.agents, false);
  assert.equal(snapshot.standard[0].fiber.state, 1);
  assert(!JSON.stringify(snapshot).includes(ctx.secret));
});

test("profile observer preserves existing user patches and records only its owned diagnostic journal", async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), "profile-readiness-probe-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  assert.equal(await installProfileReadinessProbe(runtime), true);
  const patch = join(runtime, "home/profiles/plugin-split-validation/cordis.patch.yml");
  const first = await readFile(patch, "utf8");
  assert.equal(await installProfileReadinessProbe(runtime), false);
  assert.equal(await readFile(patch, "utf8"), first);
  await writeFile(patch, "original user patch\n");
  assert.equal(await installProfileReadinessProbe(runtime), false);
  assert.equal(await readFile(patch, "utf8"), "original user patch\n");
  const ctx = context();
  const output = join(runtime, "profile-readiness.ndjson");
  await apply(ctx, { output });
  for (const cleanup of ctx.effects) await cleanup();
  const bytes = await readFile(output, "utf8");
  const rows = bytes.trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    rows.map((row) => row.phase),
    ["mounted", "dispose"],
  );
  assert(rows.every((row) => row.observerOnly === true));
  assert(!bytes.includes(ctx.secret));
});

test("Actions profile diagnostics survive temporary profile cleanup in the existing result artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "profile-readiness-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = join(root, "job");
  try {
    const runtime = join(root, "gea-profile-owned", "runtime");
    assert.equal(await installProfileReadinessProbe(runtime), true);
    const patch = JSON.parse(
      await readFile(
        join(runtime, "home/profiles/plugin-split-validation/cordis.patch.yml"),
        "utf8",
      ),
    );
    const output = patch[0].insert[0].config.output;
    assert.equal(
      output,
      join(root, "job/quality-test-results/profile-readiness-gea-profile-owned-runtime.ndjson"),
    );
    const ctx = context();
    await apply(ctx, { output });
    for (const cleanup of ctx.effects) await cleanup();
    await rm(join(root, "gea-profile-owned"), { recursive: true, force: true });
    assert.equal(JSON.parse((await readFile(output, "utf8")).split("\n")[0]).observerOnly, true);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previous;
  }
});

test("profile observer samples after mounting and cancels later samples when disposed", async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), "profile-readiness-lifecycle-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = context();
  const output = join(runtime, "profile-readiness.ndjson");
  const phases = async () =>
    (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).phase);
  await apply(ctx, { output });
  assert.equal(typeof ctx.effects[0], "function");
  assert.deepEqual(await phases(), ["mounted"]);
  t.mock.timers.tick(1000);
  for (let attempts = 0; attempts < 100; attempts++) {
    if ((await phases()).includes("after-1000")) break;
    await new Promise(setImmediate);
  }
  assert.deepEqual(await phases(), ["mounted", "after-1000"]);
  await ctx.effects[0]();
  t.mock.timers.tick(20000);
  await new Promise(setImmediate);
  assert.deepEqual(await phases(), ["mounted", "after-1000", "dispose"]);
});

test("profile observer preserves the prepared model default seed before and after disposal", async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), "profile-readiness-seed-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const seed = [
    {
      id: "agent-default-model",
      config: {
        provider: "fixture",
        model: "exact-model",
        endpoint: "https://127.0.0.1:9443/model",
        headers: { "x-fixture": "preserved" },
      },
    },
  ];
  const defaults = join(runtime, "profile-defaults.json");
  await writeFile(defaults, JSON.stringify(seed, null, 2));
  assert.equal(await installProfileReadinessProbe(runtime, defaults), true);
  const patch = join(runtime, "home/profiles/plugin-split-validation/cordis.patch.yml");
  const bytes = await readFile(patch, "utf8");
  const rows = JSON.parse(bytes);
  assert.deepEqual(rows.slice(0, -1), seed);
  assert.equal(rows.at(-1).insert[0].id, "profile-readiness-probe");
  const ctx = context();
  await apply(ctx, rows.at(-1).insert[0].config);
  await ctx.effects[0]();
  assert.equal(await readFile(patch, "utf8"), bytes);
  await writeFile(patch, "original user model selection\n");
  assert.equal(await installProfileReadinessProbe(runtime, defaults), false);
  assert.equal(await readFile(patch, "utf8"), "original user model selection\n");
});
