import test from "node:test";
import assert from "node:assert/strict";
import { orderSalesConfirmation } from "../src/host/order-sales-confirmation.ts";

test("push settings use fixed routes, current identity and a frozen rule snapshot", async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const settings = {
    thresholdEnabled: true,
    thresholdPercent: 95,
    reminderEnabled: true,
    reminderHours: 3,
  };
  const owner = scope();
  const pending = orderSalesConfirmation(
    { operation: "settings_save", settings, expectedVersion: "0" },
    owner,
    async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/session")) {
        await wait;
        return grant();
      }
      return Response.json({
        success: true,
        result: { settings: JSON.parse(init.body).settings, version: "new" },
      });
    },
  );
  settings.thresholdPercent = 0;
  release();
  const result = await pending;
  assert.equal(result.settings.thresholdPercent, 95);
  assert.ok(calls[1].url.endsWith("/settings/save"));
  await orderSalesConfirmation({ operation: "settings_get" }, owner, async (url) =>
    url.endsWith("/session") ? grant() : Response.json({ success: true, result: { settings: {} } }),
  );
});

test("push settings cannot change authority, inject recipients or save invalid intervals", async () => {
  const settings = {
    thresholdEnabled: true,
    thresholdPercent: 95,
    reminderEnabled: true,
    reminderHours: 2,
  };
  for (const payload of [
    { operation: "settings_get", userId: "other" },
    {
      operation: "settings_save",
      settings: { ...settings, chatId: "other" },
      expectedVersion: "0",
    },
    {
      operation: "settings_save",
      settings: { ...settings, reminderHours: 0 },
      expectedVersion: "0",
    },
    {
      operation: "settings_save",
      settings: { ...settings, thresholdPercent: 95.001 },
      expectedVersion: "0",
    },
    { operation: "settings_save", settings, expectedVersion: "invalid" },
  ])
    await assert.rejects(
      orderSalesConfirmation(payload, scope(), () => {
        throw Error("network must not run");
      }),
      /INVALID/,
    );
});

const selection = {
  orderNo: "order1",
  customerCode: "cust1",
  base: "郑州",
  start: "2026-10-27",
  endExclusive: "2026-10-28",
};
function scope() {
  return {
    enabled: true,
    base: "https://gea.example/gea-boot",
    auth: { token: "login-token", tenantId: "0" },
    identity: new AbortController().signal,
    signal: new AbortController().signal,
    timeoutMs: 10000,
  };
}
function grant() {
  return Response.json({
    success: true,
    result: {
      accessDecision: { allowed: true },
      delegationToken: "delegated-token",
      gatewayContext: {
        sessionId: "session1",
        conversationId: "conversation1",
        consumerType: "AGENT",
        consumerCode: "order01",
      },
    },
  });
}

test("only configured order01 actions use the current Host identity and fixed backend routes", async () => {
  const calls = [],
    owner = scope();
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? grant()
      : Response.json({
          success: true,
          result: { status: "pending", requestId: "order-sales-" + "a".repeat(64) },
        });
  };
  const result = await orderSalesConfirmation({ operation: "create", selection }, owner, fetchImpl);
  assert.equal(result.status, "pending");
  assert.equal(JSON.parse(calls[0].init.body).consumerCode, "order01");
  assert.equal(
    calls[1].url,
    "https://gea.example/gea-boot/ai/order-fulfillment/confirmation/requests",
  );
  assert.deepEqual(JSON.parse(calls[1].init.body), selection);
  assert.equal(calls[1].init.headers["X-Delegation-Token"], "delegated-token");
  assert.equal("X-Access-Token" in calls[1].init.headers, false);
  await orderSalesConfirmation({ operation: "lookup", selection }, owner, fetchImpl);
  assert.equal(calls.length, 3, "lookup reuses the same current-identity delegation");
});

test("page cannot override recipient, consumer, SQL, route or perform sales actions", async () => {
  for (const payload of [
    { operation: "confirm_shipment", selection },
    { operation: "create", selection, consumerCode: "order" },
    { operation: "create", selection, chatId: "other" },
    { operation: "create", selection, sql: "UPDATE x" },
    { operation: "status", selection, requestId: "other" },
    { operation: "create", selection: { ...selection, url: "https://other" } },
  ])
    await assert.rejects(
      orderSalesConfirmation(payload, scope(), () => {
        throw Error("must not call");
      }),
    );
});

test("disabled feature probes do not authenticate or send any message", async () => {
  const owner = { ...scope(), enabled: false };
  assert.deepEqual(
    await orderSalesConfirmation({ operation: "capabilities" }, owner, () => {
      throw Error("network");
    }),
    { available: false },
  );
  await assert.rejects(
    orderSalesConfirmation({ operation: "create", selection }, owner, () => {
      throw Error("network");
    }),
    /NOT_ENABLED/,
  );
});

test("identity cancellation prevents a late handshake from creating a task", async () => {
  const identity = new AbortController();
  let release,
    calls = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const operation = orderSalesConfirmation(
    { operation: "create", selection },
    { ...scope(), identity: identity.signal },
    async () => {
      calls++;
      await pending;
      return grant();
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  identity.abort();
  release();
  await assert.rejects(operation);
  assert.equal(calls, 1);
});

test("business failure is retained and never retried as a second write", async () => {
  let calls = 0;
  await assert.rejects(
    orderSalesConfirmation({ operation: "create", selection }, scope(), async () => {
      calls++;
      return calls === 1
        ? grant()
        : Response.json({
            success: false,
            errorCode: "ORDER_SCOPE_DENIED",
            message: "无权处理该订单",
          });
    }),
    /无权处理/,
  );
  assert.equal(calls, 2);
});

test("late success after identity cancellation is rejected rather than published", async () => {
  const identity = new AbortController();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const operation = orderSalesConfirmation(
    { operation: "create", selection },
    { ...scope(), identity: identity.signal },
    async (url) => {
      if (!url.endsWith("/requests")) return grant();
      return {
        json: async () => {
          await pending;
          return { success: true, result: { status: "pending" } };
        },
        ok: true,
      };
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  identity.abort();
  release();
  await assert.rejects(operation);
});

test("selection and operation are frozen before the authorization await", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const payload = { operation: "create", selection: { ...selection } };
  const operation = orderSalesConfirmation(payload, scope(), async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      await pending;
      return grant();
    }
    return Response.json({ success: true, result: { status: "pending" } });
  });
  payload.operation = "lookup";
  payload.selection.orderNo = "other-order";
  payload.selection.chatId = "other-chat";
  release();
  await operation;
  assert.equal(calls[1].url.endsWith("/requests"), true);
  assert.deepEqual(JSON.parse(calls[1].init.body), selection);
});

test("participant lookup and selected processing identity use fixed routes without exposing auth", async () => {
  const calls = [];
  const owner = scope();
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return String(url).endsWith("/session")
      ? grant()
      : Response.json({ success: true, result: { participants: [] } });
  };
  await orderSalesConfirmation({ operation: "participants", query: "测试" }, owner, fetchImpl);
  assert.ok(calls[1].url.endsWith("/confirmation/participants"));
  assert.deepEqual(JSON.parse(calls[1].init.body), { query: "测试" });
  await orderSalesConfirmation(
    {
      operation: "create",
      selection,
      recipientUserIds: ["viewer1", "tester"],
      handlerUserId: "tester",
    },
    owner,
    fetchImpl,
  );
  assert.ok(calls.at(-1).url.endsWith("/confirmation/requests/recipients"));
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
    selection,
    recipientUserIds: ["viewer1", "tester"],
    handlerUserId: "tester",
  });
  assert.equal("X-Access-Token" in calls.at(-1).init.headers, false);
});

test("recipient selection is frozen before awaiting the current identity handshake", async () => {
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  const ids = ["tester"];
  let sent;
  const operation = orderSalesConfirmation(
    { operation: "create", selection, recipientUserIds: ids, handlerUserId: "tester" },
    scope(),
    async (url, init) => {
      if (String(url).endsWith("/session")) {
        await pending;
        return grant();
      }
      sent = JSON.parse(init.body);
      return Response.json({ success: true, result: { status: "pending" } });
    },
  );
  ids[0] = "other";
  release();
  await operation;
  assert.deepEqual(sent.recipientUserIds, ["tester"]);
});

test("personnel selection cannot inject permissions, routes, modes or a handler outside the mentions", async () => {
  for (const payload of [
    { operation: "participants", query: "x", selection },
    { operation: "create", selection, recipientUserIds: ["a", "a"] },
    { operation: "create", selection, recipientUserIds: ["a"], handlerUserId: "b" },
    { operation: "create", selection, recipientUserIds: ["a"], testMode: true },
    {
      operation: "status",
      selection,
      requestId: "order-sales-" + "a".repeat(64),
      recipientUserIds: ["a"],
    },
    { operation: "participants", query: "x", chatId: "oc_other" },
  ])
    await assert.rejects(
      orderSalesConfirmation(payload, scope(), () => {
        throw Error("must not call");
      }),
      /INVALID/,
    );
});
