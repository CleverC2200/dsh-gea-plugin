import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({
  entryPoints: ["src/host/business-tool-display.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { businessToolDisplay } = await import(
  "data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64")
);
function constraints(value) {
  if (Array.isArray(value)) return value.map(constraints);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, item]) => [key, constraints(item)]),
  );
}

test("business tool display preserves complete schema constraints and decimal semantics", () => {
  const original = {
    name: "forecast_compute",
    description: "native calculator",
    parameters: {
      type: "object",
      required: ["records"],
      additionalProperties: false,
      properties: {
        records: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            properties: {
              quantity: {
                oneOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "null" }],
                description: "精确十进制字符串；null 或省略表示缺失，不补零。不传 JSON 浮点数。",
              },
              mode: { enum: ["provided", "mock", "live"] },
              range: { type: "integer", minimum: 0, maximum: 10 },
              unit: { type: "string", description: "fixture-specific units must survive" },
            },
          },
        },
      },
    },
  };
  const before = structuredClone(original);
  const display = businessToolDisplay(original);
  assert.deepEqual(constraints(display), constraints(original));
  assert.deepEqual(
    original,
    before,
    "the registered validator and upstream schema remain unchanged",
  );
  const description = display.parameters.properties.records.items.properties.quantity.description;
  assert.ok(
    description.length <
      before.parameters.properties.records.items.properties.quantity.description.length,
  );
  assert.match(description, /十进制字符串/);
  assert.match(description, /null.*省略.*缺失.*不补零/);
  assert.match(description, /浮点/);
  assert.equal(
    display.parameters.properties.records.items.properties.unit.description,
    "fixture-specific units must survive",
  );
});

test("business GenUI display keeps protocol and interaction without forcing UI for plain facts", () => {
  const tool = {
    name: "render_ui",
    description: "native renderer",
    parameters: {
      type: "object",
      required: ["spec"],
      properties: {
        spec: {
          type: "object",
          description: "USE THIS whenever the answer contains numbers",
          additionalProperties: false,
          properties: {
            gap: { type: "number", description: "gap in px" },
            items: { type: "array" },
          },
        },
      },
    },
  };
  const display = businessToolDisplay(tool);
  assert.deepEqual(constraints(display), constraints(tool));
  assert.match(display.description, /dsh-ui.*genui/);
  assert.match(display.description, /action.*genui-action.*重新渲染/);
  assert.match(display.parameters.properties.spec.description, /JSON 对象.*字符串/);
  assert.match(display.parameters.properties.spec.description, /简单事实.*纯文字/);
  assert.equal(display.parameters.properties.spec.properties.gap.description, "gap in px");
  assert.equal(
    tool.parameters.properties.spec.description,
    "USE THIS whenever the answer contains numbers",
  );
  const untouched = { ...tool, name: "another_tool" };
  assert.equal(businessToolDisplay(untouched), untouched);
});
