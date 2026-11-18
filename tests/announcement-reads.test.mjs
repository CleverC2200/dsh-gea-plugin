import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: [
      'export { readAnnouncements } from "./src/host/announcements.ts";',
      'export { GatewayRequests } from "./src/host/gateway-requests.ts";',
      'export { GeaApiLogCenter } from "./src/host/api-log.ts";',
    ].join("\n"),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { readAnnouncements, GatewayRequests, GeaApiLogCenter } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);

const base = "https://gea.example.test/gea-boot";
const signal = AbortSignal.timeout(5000);
const auth = { token: "fixture-token", tenantId: "fixture-tenant" };
const item = {
  id: "9223372036854775807",
  title: "会议安排",
  top: true,
  privateRecipients: ["fixture"],
};

test("announcements use the current login without tenant headers and project only public fields", async () => {
  let requests = 0;
  const gateway = new GatewayRequests({
    scope: () => ({ base, signal }),
    timeoutMs: 1000,
    expire: () => assert.fail("valid login"),
    decode: JSON.parse,
    fetch: async (url, init) => {
      requests++;
      assert.equal(init.method, "GET");
      assert.equal(init.headers["X-Access-Token"], auth.token);
      assert.equal(init.headers["X-Tenant-Id"], undefined);
      const path = new URL(url);
      if (requests === 1) {
        assert.equal(path.pathname, "/gea-boot/api/v1/announcements");
        assert.equal(path.searchParams.get("title"), "含 + &");
        assert.equal(path.searchParams.get("pageNo"), "2");
        assert.equal(path.searchParams.get("pageSize"), "20");
        return Response.json({
          success: true,
          code: 200,
          result: { items: [item], pageNo: 2, pageSize: 20, total: 21 },
        });
      }
      assert.equal(path.pathname, "/gea-boot/api/v1/announcements/" + item.id);
      return Response.json({
        success: true,
        code: 200,
        result: { ...item, content: "<p>正文</p>" },
      });
    },
  });
  const read = (path) => gateway.readResult(path, auth, signal, false);
  await assert.rejects(
    readAnnouncements({ tenantId: "other" }, read),
    /ANNOUNCEMENT_REQUEST_INVALID/,
  );
  await assert.rejects(readAnnouncements({ id: ".." }, read), /ANNOUNCEMENT_REQUEST_INVALID/);
  assert.equal(requests, 0);
  const result = await readAnnouncements({ pageNo: 2, title: "  含 + & " }, read);
  assert.deepEqual(result.items, [
    { id: item.id, title: item.title, summary: null, publishTime: null, priority: null, top: true },
  ]);
  const { detail } = await readAnnouncements({ id: item.id }, read);
  assert.equal(detail.id, item.id);
  assert.equal(detail.content, "<p>正文</p>");
  assert.equal("privateRecipients" in detail, false);
});

test("business error envelopes never become an empty announcement list", async () => {
  let body = { success: false, code: 404 };
  let expired = 0;
  const gateway = new GatewayRequests({
    scope: () => ({ base, signal }),
    timeoutMs: 1000,
    expire: (identity) => {
      assert.equal(identity, auth);
      expired++;
    },
    decode: JSON.parse,
    fetch: async () => Response.json(body),
  });
  const read = (path) => gateway.readResult(path, auth, signal, false);
  await assert.rejects(readAnnouncements({}, read), { code: "GEA_REQUEST_REJECTED" });
  body = { success: false, code: 401 };
  await assert.rejects(readAnnouncements({}, read), { code: "GEA_HTTP_401" });
  assert.equal(expired, 1);
  body = { success: true, code: 200, result: { ...item, id: "different" } };
  await assert.rejects(readAnnouncements({ id: item.id }, read), /ANNOUNCEMENT_INVALID_RESPONSE/);
});

test("announcement logs keep only request and response metadata", async () => {
  const log = new GeaApiLogCenter(
    () => "test",
    10,
    async () =>
      Response.json({
        success: true,
        code: 200,
        result: { title: "private-title", summary: "private-summary", content: "private-content" },
      }),
  );
  for (const path of [
    "/api/v1/announcements?title=private-search",
    "/api/v1/announcements/private-id",
  ])
    await log.fetch(base + path, { headers: { "X-Access-Token": auth.token } });
  const { records } = log.snapshot();
  assert.deepEqual(
    records.map((record) => record.request.path),
    ["/api/v1/announcements/{id}", "/api/v1/announcements"],
  );
  assert.ok(records.every((record) => record.replayAvailable === false));
  for (const value of [
    "private-title",
    "private-summary",
    "private-content",
    "private-search",
    "private-id",
    auth.token,
  ])
    assert.equal(JSON.stringify(records).includes(value), false);
});
