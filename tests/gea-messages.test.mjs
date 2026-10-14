import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const { outputFiles } = await build({
  entryPoints: ["src/host/gea-messages.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  packages: "external",
});
const mod = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
);
const { toGeaMessages } = mod.exports;

test("DSH 0.2 tool-role results retain call identity and text on the GEA wire", async () => {
  const result = toGeaMessages({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            id: "call-1",
            name: "stock",
            arguments: '{"sku":"A"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        source: { kind: "tool", callId: "call-1" },
        content: Object.freeze([{ type: "text", text: "库存 12" }]),
      },
    ],
  });
  assert.deepEqual(result, [
    {
      role: "assistant",
      content: undefined,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "stock", arguments: '{"sku":"A"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "库存 12" },
  ]);
});

test("retained 0.1 tool blocks remain replayable without changing their call id", async () => {
  assert.deepEqual(
    toGeaMessages({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool-result",
              toolCallId: "old-call",
              content: [{ type: "text", text: "旧回执" }],
            },
          ],
        },
      ],
    }),
    [{ role: "tool", tool_call_id: "old-call", content: "旧回执" }],
  );
});
