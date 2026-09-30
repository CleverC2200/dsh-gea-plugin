import { createReferenceStore } from "../packages/page-interaction/src/reference-store.ts";
import { installPageInteraction } from "../packages/page-interaction/src/client.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  pageReference,
  serializeReference,
  projectReferenceText,
} from "../packages/page-interaction/src/reference.ts";

test("page references keep only the chosen evidence and declared targets", () => {
  const ref = pageReference({
    page: "销售计划",
    label: "客户A · 金额",
    text: "200",
    row: "客户A",
    column: "金额",
    targets: ["row:p"],
    capturedAt: "2026-09-25",
    secret: "never",
  });
  const store = createReferenceStore();
  const receipt = store.put({
    ...ref,
    sessionId: "session-test",
    surface: "page",
    tool: "gea_workbench_apply",
  });
  const message = serializeReference(receipt);
  assert.match(message, /dsh-page:R[a-f0-9]{12}/);
  assert.equal(message.includes("200"), false);
  assert.equal(message.includes("row:p"), false);
  assert.equal(
    store.read("session-other", receipt.id).error,
    "REFERENCE_UNAVAILABLE",
  );
  assert.equal(store.read("session-test", receipt.id).text, "200");
  store.dispose();
  assert.equal(
    store.read("session-test", receipt.id).error,
    "REFERENCE_UNAVAILABLE",
  );
  assert.equal(pageReference({ text: "" }), undefined);
});

test("large excerpts are visibly marked as truncated, without expanding the page", () => {
  const ref = pageReference({ text: "甲".repeat(7000), targets: ["row:p"] });
  assert.equal(ref.text.length, 6000);
  assert.equal(ref.truncated, true);
});

test("group references retain every declared target", () => {
  const targets = Array.from({ length: 40 }, (_, index) => `row:${index}`);
  assert.deepEqual(
    pageReference({ text: "整组计划", targets }).targets,
    targets,
  );
});

for (const phase of ["saving", "reload"]) test(`a saved reference cannot enter the composer after disposal during ${phase}`, async (t) => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  });
  const listeners = new Map();
  globalThis.window = {
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
  };
  let resolveFetch;
  globalThis.fetch = (url) => url === "/api/page-interaction/binding"
    ? Promise.resolve(Response.json({ generation: "fixture" }))
    : new Promise((resolve) => {
      resolveFetch = resolve;
    });
  let inserts = 0;
  const notifications = [];
  const frameListeners = new Map();
  const scope = {
    effect: (fn) => fn(),
    inputTriggers: { registerSource: () => () => {} },
    uiSession: { mainSessionId: { getSnapshot: () => "session-test", subscribe: () => () => {} } },
    sessions: {
      list: { getSnapshot: () => ({
        byId: { "session-test": { id: "session-test", retainedBy: { mainView: 1 } } },
      }) },
      binding: () => ({ ctx: {} }),
    },
    conversation: {
      input: {
        for: () => ({
          notify: (_level, message) => notifications.push(message),
          state: { getSnapshot: () => ({ draft: "", draftRev: 0 }) },
          insertReference: () => {
            inserts++;
            return true;
          },
        }),
      },
    },
  };
  const ctx = {
    get: () => undefined,
    provide: () => {},
    inject: (_names, fn) => fn(scope),
  };
  let channel;
  const frame = {
    contentWindow: {
      postMessage: (message) => {
        channel = message.channel;
      },
    },
    addEventListener: (name, listener) => frameListeners.set(name, listener),
    removeEventListener: name => frameListeners.delete(name),
  };
  const dispose = installPageInteraction(ctx).bindFrame({
    frame,
    sessionId: "session-test",
    page: "表格",
    surface: "page",
  });
  await new Promise(resolve => setImmediate(resolve));
  const receive = [...listeners.get("message")][0];
  const received = receive({
    source: frame.contentWindow,
    data: {
      protocol: "dsh-page-interaction-v1",
      channel,
      type: "reference",
      requestId: "pending",
      reference: { label: "整行", text: "120", targets: [], ...(phase !== "saving" ? { scope: "current" } : {}) },
    },
  });
  if (phase === "reload") frameListeners.get("load")();
  else dispose();
  resolveFetch(Response.json({ id: "R123456abcdef", label: "表格 · 整行" }));
  await received;
  assert.equal(inserts, 0);
  if (phase === "reload") {
    assert.deepEqual(notifications, ["页面已重新加载，请重新选择引用。"]);
    dispose();
  }
  assert.equal(listeners.get("message").size, 0, "disposal removes the binding listener");
});

test("sent references project to the same label without leaking the wire ID", () => {
  const receipt = { id: "R123456abcdef", label: "销售计划 · 表格 · 9 行" };
  assert.deepEqual(
    projectReferenceText(serializeReference(receipt) + "分析这些"),
    {
      text: "销售计划 · 表格 · 9 行 分析这些",
      labels: [receipt.label],
      ranges: [{ start: 0, end: receipt.label.length }],
    },
  );
  assert.deepEqual(projectReferenceText("普通消息"), {
    text: "普通消息",
    labels: [],
    ranges: [],
  });
});

test("reference labels round-trip brackets, slashes, percent and Unicode", () => {
  const label = "销售计划 · 客户[直营]/50%";
  assert.equal(
    projectReferenceText(serializeReference({ id: "R123456abcdef", label }))
      .text,
    label + " ",
  );
});
