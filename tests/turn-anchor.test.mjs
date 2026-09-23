/**
 * 每步注入的"本轮用户提问"锚点：不能重复堆、不能把工具结果当提问、换问题要就地替换。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/host/turn-anchor.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
  outdir: "out",
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const {
  anchorMessages,
  isTurnAnchor,
  lastUserQuestion,
  mountTurnAnchor,
  turnAnchorText,
} = module.exports;

const { createUserMessage } = createRequire(import.meta.url)("@deepseek-ai/dsh-llm");
const userMsg = (text) =>
  createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] });
const toolMsg = (text) => ({
  role: "user",
  source: { kind: "tool", callId: "call-1" },
  content: [{ type: "tool-result", content: [{ type: "text", text }] }],
});
const anchor = (text) =>
  createUserMessage({
    source: { kind: "plugin", plugin: "gea-plugin", form: "notice", summary: "宿主" },
    content: [{ type: "text", text }],
  });

test("只认用户自己发的消息：工具结果、宿主注入都不算提问", () => {
  assert.equal(lastUserQuestion([]), undefined);
  assert.equal(lastUserQuestion([toolMsg("500 rows")]), undefined);
  assert.equal(
    lastUserQuestion([toolMsg("rows"), userMsg("郑州基地的大日期库存有哪些？")]),
    "郑州基地的大日期库存有哪些？",
  );
  // 最后一条才是"用户这一轮问的"：更早的提问不算。
  assert.equal(
    lastUserQuestion([userMsg("旧问题"), toolMsg("rows"), userMsg("新问题")]),
    "新问题",
  );
});

test("锚点正文把原话和「别的都不算提问」写在一起", () => {
  const text = turnAnchorText("郑州基地的大日期库存有哪些？分别有多少？");
  assert.match(text, /【宿主事实｜本轮用户提问】/);
  assert.match(text, /「郑州基地的大日期库存有哪些？分别有多少？」/);
  assert.match(text, /都不是用户的提问/);
  assert.match(text, /不能因此说“没收到提问”“用户消息是空的”/);
  // 超长问题要截断，别把上下文再撑大。
  assert.ok(turnAnchorText("问".repeat(2000)).length < 800);
});

test("没有用户提问就不注入；有就追加到末尾", () => {
  const only = [toolMsg("rows")];
  assert.equal(anchorMessages(only, undefined, anchor), only);
  const withQuestion = anchorMessages(
    [userMsg("郑州基地的大日期库存有哪些？"), toolMsg("rows")],
    "郑州基地的大日期库存有哪些？",
    anchor,
  );
  assert.equal(withQuestion.length, 3);
  assert.match(withQuestion[2].content[0].text, /郑州基地的大日期库存有哪些？/);
  assert.ok(isTurnAnchor(withQuestion[2]));
});

test("同一个问题只留一条锚点：内容没变不动，换了问题就地替换", () => {
  const first = anchorMessages([userMsg("问题一")], "问题一", anchor);
  const again = anchorMessages(first, "问题一", anchor);
  assert.equal(again, first, "内容没变时不能重复追加");
  const changed = anchorMessages(again, "问题二", anchor);
  assert.equal(changed.length, first.length, "换问题只替换，不新增");
  assert.match(
    changed.find((message) => isTurnAnchor(message)).content[0].text,
    /问题二/,
  );
  assert.equal(changed.filter((message) => isTurnAnchor(message)).length, 1);
});

test("挂到 agent/pre-step 上：每一步都能拿到带锚点的消息列表", async () => {
  const hooks = [];
  const ctx = {
    on(event, handler) {
      assert.equal(event, "agent/pre-step");
      hooks.push(handler);
      return () => {};
    },
  };
  const dispose = mountTurnAnchor(ctx);
  assert.equal(hooks.length, 1);
  const controller = new AbortController();
  const messages = [userMsg("郑州基地的大日期库存有哪些？"), toolMsg("rows")];
  const decision = await hooks[0](
    { agent: { id: "s1" }, messages: [], step: 2, turn: 1, signal: controller.signal },
    async () => ({ kind: "accept", messages }),
  );
  assert.equal(decision.messages.length, 3);
  assert.match(decision.messages[2].content[0].text, /郑州基地的大日期库存有哪些？/);

  // 被拒绝的 step 不改动；没有用户提问时原样返回。
  const rejected = await hooks[0](
    { agent: { id: "s1" }, messages: [], step: 1, turn: 1, signal: controller.signal },
    async () => ({ kind: "reject", messages }),
  );
  assert.equal(rejected.messages, messages);
  const empty = await hooks[0](
    { agent: { id: "s1" }, messages: [], step: 1, turn: 1, signal: controller.signal },
    async () => ({ kind: "accept", messages: [toolMsg("rows")] }),
  );
  assert.equal(empty.messages.length, 1);
  dispose();
});
