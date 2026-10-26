import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DmsClient, parseDmsOrder, submitDmsOrder } from "../src/host/dms-orders.ts";
const config = {
  gatewayUrl: "http://gateway.test/synear_test/DMS",
  manageUrl: "https://manage.test",
  secretEnv: "DMS_UNIT_TEST_SECRET",
  users: [],
};
process.env.DMS_UNIT_TEST_SECRET = "fixture-secret";
const input = {
  aiPreOrderCode: "AI123",
  customerCode: "C1",
  addressCode: "A1",
  pupCode: "P1",
  itemList: [{ productCode: "SKU1", quantity: 1.25 }],
};
const signal = () => new AbortController().signal;
const ok = (result) => Response.json({ success: true, code: 200, result });
const login = {
  access_token: "private-access",
  redirect: "https://manage.test/user/loginSSO?token=short-ticket",
};
test("login signs form JSON, preserves gateway prefix and never sends bearer to token exchange", async () => {
  const requests = [];
  const client = new DmsClient(config, { workcode: "W1" }, async (url, init) => {
    requests.push({ url, init });
    return ok(
      requests.length === 1 ? login : { access_token: "exchanged", refresh_token: "refresh" },
    );
  });
  assert.equal((await client.login(signal())).accessToken, "private-access");
  const signed = JSON.parse(new URLSearchParams(requests[0].init.body).get("ssoToken"));
  assert.equal(signed.source, "ai");
  assert.equal(signed.workcode, "W1");
  assert.equal(
    signed.sign,
    createHash("md5")
      .update("W1" + signed.time + "fixture-secret")
      .digest("hex"),
  );
  assert.equal(requests[0].url, "http://gateway.test/synear_test/DMS/auth/oauthout/ssoLogin");
  assert.equal(requests[0].init.redirect, "error");
  await client.exchange("a+b&x", "order", signal());
  assert.equal(new URL(requests[1].url).searchParams.get("key"), "a+b&x");
  assert.equal(requests[1].init.headers, undefined);
});
test("validates required fields, quantities, enums, duplicate SKU and carpool rules", () => {
  const order = parseDmsOrder(input);
  assert.equal(order.deliveryMethod, "ps");
  for (const patch of [
    { customerCode: "" },
    { deliveryMethod: "bad" },
    { isCarpooling: "L" },
    { itemList: [] },
    { itemList: [{ productCode: "X", quantity: NaN }] },
    { itemList: [...input.itemList, ...input.itemList] },
    { token: "injected" },
  ])
    assert.throws(() => parseDmsOrder({ ...input, ...patch }));
});
test("acknowledged submission persists and duplicate intent returns receipt without remote write", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dms-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const client = new DmsClient(config, { username: "U1" }, async (url, init) => {
    requests.push({ url, init });
    return ok(url.endsWith("ssoLogin") ? login : { orderCode: "D1", aiPreOrderCode: "AI123" });
  });
  const order = parseDmsOrder(input);
  assert.equal((await submitDmsOrder(dir, "owner", order, client, signal())).orderCode, "D1");
  assert.equal(requests[1].init.headers.Authorization, "Bearer private-access");
  assert.deepEqual(JSON.parse(requests[1].init.body), order);
  assert.equal(
    requests[1].url,
    "http://gateway.test/synear_test/DMS/dms/order/dmsOrderHead/submitZcOrderDirect",
  );
  await submitDmsOrder(dir, "owner", order, client, signal());
  assert.equal(requests.length, 2);
  await assert.rejects(
    submitDmsOrder(
      dir,
      "owner",
      parseDmsOrder({ ...input, addressCode: "OTHER" }),
      client,
      signal(),
    ),
    /另一份订单/,
  );
});
test("unknown writes survive new client instance; never replay after timeout or invalid receipt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dms-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let writes = 0;
  const transport = async (url) => {
    if (url.endsWith("ssoLogin")) return ok(login);
    writes++;
    throw Error("network lost private-access");
  };
  const order = parseDmsOrder(input);
  await assert.rejects(
    submitDmsOrder(
      dir,
      "owner",
      order,
      new DmsClient(config, { username: "U" }, transport),
      signal(),
    ),
    /未取得可确认回执/,
  );
  await assert.rejects(
    submitDmsOrder(
      dir,
      "owner",
      order,
      new DmsClient(config, { username: "U" }, transport),
      signal(),
    ),
    /结果未知/,
  );
  assert.equal(writes, 1);
});
test("rejects foreign redirects, business errors, mismatched receipts and cancelled calls", async () => {
  await assert.rejects(
    new DmsClient(config, { username: "U" }, async () =>
      ok({ ...login, redirect: "https://evil.test/user/loginSSO?token=x" }),
    ).login(signal()),
    /免登地址/,
  );
  await assert.rejects(
    new DmsClient(config, { username: "U" }, async () =>
      Response.json({ success: false, code: 500, message: "private-access" }),
    ).login(signal()),
    /DMS 拒绝/,
  );
  await assert.rejects(
    new DmsClient(config, { username: "U" }, async () =>
      ok({ orderCode: "D", aiPreOrderCode: "other" }),
    ).submit(parseDmsOrder(input), "token", signal()),
    /回执不匹配/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new DmsClient(config, { username: "U" }, async () => {
      throw Error("must not send");
    }).login(controller.signal),
    /abort/i,
  );
});

test("empty HTTP 200 is not an acknowledged DMS order", async () => {
  const client = new DmsClient(
    config,
    { username: "U" },
    async () => new Response(null, { status: 200 }),
  );
  await assert.rejects(client.submit(parseDmsOrder(input), "fixture-token", signal()));
});
