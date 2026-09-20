import test from "node:test";
import assert from "node:assert/strict";
import { prepareGatewayLaunch } from "../src/host/html-gateway.ts";

const launch = (result) => prepareGatewayLaunch(
  "https://example.invalid", { token: "test", tenantId: "0" },
  { consumerType: "AGENT", consumerCode: "inventory-personal-workbench" },
  new AbortController().signal, 1000,
  async () => Response.json({ success: true, result }),
);

test("explicit Agent denial retains an actionable permission error without granting a session", async () => {
  await assert.rejects(launch({
    accessDecision: { allowed: false, code: "AGENT_ACCESS_DENIED" },
    gatewayContext: { consumerCode: "inventory-personal-workbench" },
  }), { code: "AGENT_ACCESS_DENIED", message: "当前账号无权访问此工作台，请联系管理员开通对应 Agent 权限。" });
});

test("an allowed decision with incomplete credentials still rejects the session", async () => {
  await assert.rejects(launch({ accessDecision: { allowed: true } }), /GEA_MCP_SESSION_REJECTED/);
});
