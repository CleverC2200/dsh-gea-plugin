import test from "node:test";
import assert from "node:assert/strict";
import { Config } from "../lib/host.js";

test("model idle defaults to ten minutes independently of MCP and preserves explicit settings", () => {
  const defaults = Config({});
  assert.equal(defaults.modelRequestTimeoutMs, 600000);
  assert.equal(defaults.mcpRequestTimeoutMs, 300000);
  const custom = Config({ modelRequestTimeoutMs: 120000, mcpRequestTimeoutMs: 45000 });
  assert.equal(custom.modelRequestTimeoutMs, 120000);
  assert.equal(custom.mcpRequestTimeoutMs, 45000);
});
