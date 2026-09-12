import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "approval conflicts preserve HTTP classification and safe backend diagnostics",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    await app.login();
    app.route((req, res, reply) => {
      if (!req.url.pathname.endsWith("/versions/v/actions")) return false;
      reply(
        {
          message: "业务状态冲突",
          errorCode: "SALES_PLAN_CONFLICT",
          requestId: "req",
        },
        409,
      );
      return true;
    });
    const result = await app.rpc("sales-plan/action", {
      versionId: "v",
      request: { action: "APPROVE", expectedStatus: 1 },
      idempotencyKey: "test-key",
      requestId: "req",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GEA_HTTP_409");
    assert.match(result.error.message, /业务状态冲突/);
    assert.equal(result.error.details.upstreamCode, "SALES_PLAN_CONFLICT");
  },
);
