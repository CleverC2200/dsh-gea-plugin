import test from "node:test";
import assert from "node:assert/strict";
import { orderSalesConfirmation } from "../src/host/order-sales-confirmation.ts";

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
