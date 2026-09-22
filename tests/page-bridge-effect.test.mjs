/**
 * 提交/审批类动作的确认边界（宿主侧硬规则）：
 *   - 元素可以声明影响等级（draft / submit / approve）；
 *   - 声明为提交/审批的元素，没有用户明确要求（confirm）时一律不下发；
 *   - 说明里把这类元素标出来，并给出 confirm 参数。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/page-bridge/catalog.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const m = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);

const catalog = (elements) =>
  m.validatePageCatalog({
    surface: "gea-workbench",
    tool: "gea_workbench_apply",
    description: "改这一屏。",
    elements,
  });

test("目录接受影响等级，拒绝没定义过的等级", () => {
  const parsed = catalog([
    {
      id: "action:approve",
      role: "control",
      label: "通过",
      actions: ["invoke"],
      effect: "approve",
    },
  ]);
  assert.equal(parsed.elements[0].effect, "approve");
  assert.throws(
    () =>
      catalog([
        {
          id: "action:weird",
          role: "control",
          label: "怪动作",
          actions: ["invoke"],
          effect: "publish",
        },
      ]),
    /INVALID_PAGE_CATALOG/,
  );
});

test("没有用户明确要求时，提交/审批类元素不下发", () => {
  const parsed = catalog([
    {
      id: "action:approve",
      role: "control",
      label: "通过",
      actions: ["invoke"],
      effect: "approve",
    },
    {
      id: "action:expand",
      role: "control",
      label: "展开",
      actions: ["expand"],
    },
  ]);
  assert.equal(
    m.resolvePageAction(parsed, {
      kind: "invoke",
      target: "action:approve",
      action: "invoke",
    }),
    "CONFIRMATION_REQUIRED",
  );
  assert.equal(
    m.resolvePageAction(parsed, {
      kind: "invoke",
      target: "action:approve",
      action: "invoke",
      confirm: true,
    }),
    null,
  );
  // 普通动作不需要确认。
  assert.equal(
    m.resolvePageAction(parsed, {
      kind: "invoke",
      target: "action:expand",
      action: "expand",
    }),
    null,
  );
});

test("一次调用按涉及元素的最高等级取影响面", () => {
  const parsed = catalog([
    { id: "row:p-1", role: "row", label: "某行", actions: ["select"] },
    {
      id: "action:submit",
      role: "control",
      label: "提交",
      actions: ["invoke"],
      effect: "submit",
    },
    {
      id: "action:approve",
      role: "control",
      label: "通过",
      actions: ["invoke"],
      effect: "approve",
    },
  ]);
  assert.equal(m.pageActionEffect(parsed, { kind: "select", target: "row:p-1" }), "draft");
  assert.equal(
    m.pageActionEffect(parsed, { kind: "invoke", targets: ["action:submit"] }),
    "submit",
  );
  assert.equal(
    m.pageActionEffect(parsed, {
      kind: "invoke",
      targets: ["action:submit", "action:approve"],
    }),
    "approve",
  );
});

test("说明里标出提交/审批类元素，并暴露 confirm 参数", () => {
  const parsed = catalog([
    {
      id: "action:approve",
      role: "control",
      label: "通过",
      actions: ["invoke"],
      effect: "approve",
    },
  ]);
  const compiled = m.compilePageCatalog(parsed);
  assert.match(compiled.description, /审批类/);
  const confirm = compiled.parameters.find((parameter) => parameter.name === "confirm");
  assert.ok(confirm, "编译结果必须带 confirm 参数");
  assert.equal(confirm.required, undefined);
});
