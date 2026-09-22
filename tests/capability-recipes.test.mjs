// 只读配方：常见问题不再靠模型现拼 SQL。
//
// 线上现象：模型有 describe、也知道表名，但自己拼的 SQL 在与网关受控契约对齐时
// 不稳，一轮连试二十多次后整轮空答。配方把"这类问题怎么查"收回契约。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const { outputFiles } = await build({
  stdin: {
    contents:
      "export * from './src/capability/recipes.ts'; export * from './src/html-query.ts';",
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

test("库存类模块都有配方，且配方是参数化的只读语句", () => {
  const recipes = m.recipesFor("branch-inventory");
  assert.ok(recipes.length >= 2, "库存模块至少要有一条配方");
  for (const recipe of recipes) {
    assert.match(recipe.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(recipe.title.length > 0);
    // 只读、参数化、不写分页（分页由宿主统一加）。
    assert.match(recipe.sql, /^SELECT|^WITH/, `配方必须是只读查询: ${recipe.id}`);
    assert.ok(!/;\s*\S/.test(recipe.sql), "配方不能是多条语句");
    assert.equal(/\bLIMIT\b|\bOFFSET\b/i.test(recipe.sql), false, "配方不写分页");
    assert.ok(!/\$\{/.test(recipe.sql), "配方不能带模板插值");
    for (const param of recipe.params ?? [])
      assert.match(recipe.sql, new RegExp(`:${param.name}\\b`));
  }
  assert.ok(m.recipesFor("base-safety-stock").length >= 2);
  assert.deepEqual(m.recipesFor("aps-demand-collaboration"), []);
});

test("配方 SQL 能通过宿主的只读校验（参数齐全）", () => {
  const recipe = m.findRecipe("branch-inventory", "shortage-by-base-and-group");
  assert.ok(recipe);
  const prepared = m.prepareHtmlQuery({
    sql: recipe.sql,
    parameters: { base: "%郑州%", group: "%冷鲜肉水饺%" },
  });
  assert.equal(prepared.values.length, 2);
  assert.match(prepared.sql, /\$1/);
  assert.match(prepared.sql, /\$2/);
});

test("缺参数时报可读错误，不拼出半截 SQL", () => {
  const recipe = m.findRecipe("branch-inventory", "shortage-by-base-and-group");
  assert.deepEqual(m.missingRecipeParams(recipe, { base: "%郑州%" }), ["group"]);
  assert.deepEqual(
    m.missingRecipeParams(recipe, { base: "%郑州%", group: "%水饺%" }),
    [],
  );
  assert.equal(m.findRecipe("branch-inventory", "not-a-recipe"), undefined);
});

test("配方调用不能把 recipe 透传给受管查询（否则 INVALID_PAYLOAD）", async () => {
  const source = await readFile(
    new URL("../src/host/agent-tools.ts", import.meta.url),
    "utf8",
  );
  // 线上实测：整包透传 args 会把 recipe/describe 带进 pluginSql，被 keys() 判成
  // INVALID_PAYLOAD —— 任何走 recipe 的调用都会失败。
  assert.equal(source.includes("{ pageSize: 50, ...args, sql: statement }"), false);
  assert.match(source, /consumerCode: args\.consumerCode,/);
  assert.match(source, /recipe \? recipe\.sql : args\.sql/);
});
