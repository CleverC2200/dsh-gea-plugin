import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (contents, platform = "node") => {
  const { outputFiles } = await build({
    stdin: { contents, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    platform,
    format: "esm",
  });
  return import("data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64"));
};

const host = await bundle("export * from './src/page-bridge/host.ts';");
const client = await bundle("export * from '../dsh-agent-workbench/src/page-interaction/page-bridge/client.ts';", "browser");

test("宿主超时取消后不会再下发调用，也会丢弃迟到回执", async () => {
  const bridge = host.createPageBridge({ id: () => "call-1" });
  const callId = bridge.enqueue("session-1", { toolCallName: "tool", args: {} });
  bridge.cancel("session-1", callId);
  assert.deepEqual(bridge.pull("session-1", []), []);
  bridge.pull("session-1", [{ id: "late", role: "tool", toolCallId: callId, content: '{"applied":true}' }]);
  assert.equal(bridge.take("session-1", callId), undefined);
  assert.equal(await bridge.wait("session-1", callId, 0), undefined);
});

test("页面侧应用超时会发出 AbortSignal，且清理迟到的应用回调", async () => {
  let resolveApply;
  let aborted = false;
  const requests = [];
  const dispose = client.startPageBridgeClient({
    endpoint: "page-bridge",
    sessionId: "session-1",
    initialDelayMs: 0,
    pollMs: 1000,
    applyTimeoutMs: 10,
    request: async (_endpoint, payload) => {
      requests.push(payload);
      if (requests.length === 1)
        return { events: [
          { type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "tool" },
          { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: "{}" },
          { type: "TOOL_CALL_END", toolCallId: "call-1" },
        ] };
      return { events: [] };
    },
    apply: (_args, _meta, signal) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise((resolve) => { resolveApply = resolve; });
    },
    closeOnDispose: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(aborted, true);
  resolveApply?.({ applied: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  dispose();
});
