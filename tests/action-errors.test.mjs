import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
const { outputFiles } = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts'; export {errorEnvelope} from './src/host/error-envelope.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { Business, errorEnvelope } = module.exports;

test(
  "approval conflicts preserve HTTP classification and safe backend diagnostics",
  { timeout: 60000 },
  async (t) => {
    const business = new Business({
      geaBaseUrl: "https://gea.example.test",
      requestTimeoutMs: 1000,
      analysisAgentCode: "sales_forecast",
      workbenchCapability: { enabled: true },
    });
    t.after(() => business.dispose());
    business.restoreDesktopLogin({
      schema: 1,
      environment: "production",
      base: "https://gea.example.test",
      auth: { token: "fixture-token", tenantId: "0", id: "1", name: "测试用户", username: "test" },
    });
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const req = { url: new URL(url) };

      let response;
      const reply = (body, status = 200) => {
        response = Response.json(body, { status });
        return response;
      };
      if (req.url.pathname.endsWith("/ai/gateway/agent/session"))
        return reply({
          success: true,
          code: 200,
          result: {
            accessDecision: { allowed: true },
            delegationToken: "fixture-delegation",
            gatewayContext: { sessionId: "SES-fixture" },
          },
        });
      if (req.url.pathname.endsWith("/current-user/resolve"))
        return reply({
          success: true,
          code: 200,
          result: {
            success: true,
            userId: "1",
            username: "test",
            tenantId: "0",
            realName: "测试用户",
            roles: [{ code: "sales_plan_region_approver", name: "区域审批" }],
            roleCodes: "sales_plan_region_approver",
            departments: [],
          },
        });
      if (req.url.pathname.endsWith("/ai/gateway/sql/execute"))
        return reply({
          success: true,
          code: 200,
          result: {
            rows: ["0", "1", "2", "3", "4", "Y"].map((node, level) => ({
              id: level + 1,
              type_code: "Y",
              examine_level: String(level),
              node_num: node,
            })),
            total: 6,
            pageNo: JSON.parse(init.body).pageNo,
            pageSize: JSON.parse(init.body).pageSize,
            requestId: new Headers(init.headers).get("x-request-id"),
            operation: "SELECT",
            tables: ["agents_scm_plan_workflow_config"],
          },
        });
      if (req.url.pathname.endsWith("/getPermCode")) {
        reply({ success: true, result: { codeList: ["sales-plan:plan:region-approve"] } });
        return response;
      }
      if (req.url.pathname.endsWith("/plans/p")) {
        reply({
          success: true,
          result: {
            currentVersion: { id: "v", planId: "p", effective: true, status: 1, planTypeCode: "Y" },
            skus: [],
            versions: [],
            logs: [],
            actionContext: {
              versionId: "v",
              status: 1,
              nodeOrder: 2,
              snapshotHash: "a".repeat(64),
              allowedActions: ["APPROVE"],
            },
          },
        });
        return response;
      }
      assert.ok(req.url.pathname.endsWith("/versions/v/actions"), "unexpected request: " + url);
      reply(
        {
          message: "业务状态冲突",
          errorCode: "SALES_PLAN_CONFLICT",
          requestId: "req",
        },
        409,
      );
      return response;
    });
    await business.refreshApprovalRoles(new AbortController().signal);
    await business.refreshPermissions(new AbortController().signal);
    const result = await business
      .salesPlanAction(
        {
          planId: "p",
          versionId: "v",
          request: {
            action: "APPROVE",
            expectedStatus: 1,
            approvalRole: "region",
            expectedSnapshot: "a".repeat(64),
          },
          idempotencyKey: "test-key",
          requestId: "req",
        },
        new AbortController().signal,
      )
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error: errorEnvelope(error) }),
      );

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GEA_HTTP_409", JSON.stringify(result));
    assert.match(result.error.message, /业务状态冲突/);
    assert.equal(result.error.details.upstreamCode, "SALES_PLAN_CONFLICT");
  },
);
