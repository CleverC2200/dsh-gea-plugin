import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("APS trusted policy enables exactly the approved three Skills without changing Consumers", async () => {
  const policy = JSON.parse(
    await readFile(new URL("../presets/execution-policy.json", import.meta.url), "utf8"),
  );
  const aps = policy.profiles["gea-html-inventory-apsplan"];
  assert.deepEqual(aps.skills, [
    "plan-operations-weekly-report",
    "answer-visualization",
    "order-satisfaction-analysis",
  ]);
  assert.equal(aps.consumerCode, "aps");
  assert.deepEqual(aps.crossConsumers, ["sales_forecast"]);
});
