import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const { outputFiles } = await build({
  entryPoints: ["packages/agent-workbench/src/workbench.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { WorkbenchController } = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].text).toString("base64")
);
function fixture(overrides = {}) {
  let navigation = new AbortController(),
    selected,
    panel,
    created = 0;
  const ports = {
    create: async () =>
      `session-${String(++created).padStart(8, "0")}-0000-0000-0000-000000000000`,
    prepare: async () => {},
    available: () => true,
    select: (id) => {
      selected = id;
    },
    panel: (id) => {
      panel = id;
      navigation.abort();
      controller.selectPanel(id);
    },
    beginNavigation: () => {
      navigation.abort();
      navigation = new AbortController();
      return navigation.signal;
    },
    showConversation: () => () => {},
    ...overrides,
  };
  const controller = new WorkbenchController(ports);
  return {
    controller,
    ports,
    get selected() {
      return selected;
    },
    get panel() {
      return panel;
    },
    get created() {
      return created;
    },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
test("pages and business instances retain separate sessions without changing their preset", async () => {
  const f = fixture();
  f.controller.register({ id: "gea", preset: "gea" });
  f.controller.register({ id: "example", preset: "standard" });
  await f.controller.open("gea", "a");
  const a = f.selected;
  await f.controller.open("example", "a");
  const b = f.selected;
  assert.notEqual(a, b);
  await f.controller.open("gea", "b");
  const c = f.selected;
  assert.notEqual(a, c);
  await f.controller.open("gea", "a");
  assert.equal(f.selected, a);
  assert.equal(f.created, 3);
});
test("coalesces duplicate instance creation and latest navigation wins", async () => {
  const d = deferred();
  let calls = 0;
  const f = fixture({
    create: () => {
      calls++;
      return d.promise;
    },
  });
  f.controller.register({ id: "gea", preset: "gea" });
  const a = f.controller.open("gea"),
    b = f.controller.open("gea");
  d.resolve("session-one");
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(f.selected, "session-one");
});
test("a slow request cannot steal selection from another page", async () => {
  const d = deferred();
  const f = fixture({
    create: (p) => (p === "slow" ? d.promise : Promise.resolve("fast-session")),
  });
  f.controller.register({ id: "a", preset: "slow" });
  f.controller.register({ id: "b", preset: "fast" });
  const a = f.controller.open("a");
  await f.controller.open("b");
  d.resolve("slow-session");
  await a;
  assert.equal(f.panel, "b");
  assert.equal(f.selected, "fast-session");
});
test("unregistration and logout invalidate pending association without stopping the host", async () => {
  for (const action of ["unregister", "forget", "dispose"]) {
    const d = deferred();
    const f = fixture({ create: () => d.promise });
    const off = f.controller.register({ id: "a", preset: "a" });
    const a = f.controller.open("a");
    if (action === "unregister") off();
    else if (action === "forget") f.controller.forget("a");
    else f.controller.dispose();
    d.resolve("late-session");
    await a;
    assert.equal(f.panel, undefined);
    assert.equal(f.selected, undefined);
  }
});
test("an explicitly associated session wins over earlier creation for the same instance", async () => {
  const d = deferred();
  const f = fixture({ create: () => d.promise });
  f.controller.register({ id: "a", preset: "a" });
  const pending = f.controller.open("a");
  await f.controller.open("a", "default", "chosen-session");
  d.resolve("late-session");
  await pending;
  await f.controller.open("a");
  assert.equal(f.selected, "chosen-session");
});
test("storage restores associations and malformed entries cannot become session identities", async () => {
  let stored;
  const storage = {
    getItem: () => stored,
    setItem: (_k, v) => {
      stored = v;
    },
  };
  const a = fixture({ storage });
  a.controller.register({ id: "gea", preset: "gea" });
  await a.controller.open("gea", "business-a");
  const id = a.selected;
  const b = fixture({ storage });
  b.controller.register({ id: "gea", preset: "gea" });
  await b.controller.open("gea");
  assert.equal(b.selected, id);
  assert.equal(b.created, 0);
  stored = '[["gea","default",[["default",{"invalid":true}]]]]';
  const c = fixture({ storage });
  c.controller.register({ id: "gea", preset: "gea" });
  await c.controller.open("gea");
  assert.equal(c.created, 1);
});
test("failed session preparation preserves navigation and rejects to the caller", async () => {
  const f = fixture({
    prepare: async () => {
      throw new Error("unavailable");
    },
  });
  f.controller.register({ id: "a", preset: "a" });
  await assert.rejects(f.controller.open("a"), /unavailable/);
  assert.equal(f.selected, undefined);
});

test("a restored association waits for the session list instead of crashing initial panel selection", () => {
  const storage = {
    getItem: () =>
      JSON.stringify([
        [
          "gea",
          "default",
          [["default", "session-00000000-0000-0000-0000-000000000001"]],
        ],
      ]),
    setItem: () => {},
  };
  const f = fixture({ storage, available: () => false });
  f.controller.register({ id: "gea", preset: "gea" });
  f.controller.selectPanel("gea");
  assert.equal(f.selected, undefined);
});
