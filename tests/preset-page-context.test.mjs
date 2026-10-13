import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { surfacePromptLine } from "../src/host/workbench-surface.ts";
import {
  profileFor,
  allowedTools,
  COMMON_PROMPT,
  TOOL_DESCRIPTIONS,
} from "../src/host/prompt-policy.ts";

test("scope queries do not require a bound page; page references cannot fabricate a page", () => {
  const main = surfacePromptLine(undefined);
  assert.match(main, /未绑定/);
  assert.match(main, /不空读页面/);
  assert.match(main, /gea_cube_query/);
  assert.match(COMMON_PROMPT, /独立查询无需开页面/);
  const profile = profileFor("gea-readonly");
  assert.ok(allowedTools(profile).has("gea_sales_plan_read"));
  assert.ok(allowedTools(profile).has("gea_visible_workbench_context"));
  assert.ok(!allowedTools(profile).has("gea_page"));
  assert.ok(allowedTools(profile, true).has("gea_page"));
});
test("page context keeps a narrow focus and does not claim complete scope", async () => {
  assert.match(TOOL_DESCRIPTIONS.gea_visible_workbench_context, /focus/);
  assert.match(TOOL_DESCRIPTIONS.gea_visible_workbench_context, /不是全量/);
  const business = await readFile(new URL("../src/host/business.ts", import.meta.url), "utf8");
  assert.match(business, /本工具每轮最多调用一次/);
});
test("ordinary statistics do not mandate a Skill and generic sessions have no business profile", async () => {
  const core = allowedTools(profileFor("gea-readonly"));
  assert.ok(core.has("skill"));
  assert.ok(core.has("gea_capabilities"));
  assert.ok(!core.has("subagents_run"));
  assert.equal(profileFor("auto-negotiation"), undefined);
});
