import test from "node:test";
import assert from "node:assert/strict";
import { parseFirstJsonObject, catalogFactSummary } from "../src/host/gateway-catalog.ts";

test("工具正文保留首个完整 JSON 与截断拒绝", () => {
  const payload = '{"semanticModel":[{"name":"model","text":"escaped \\\" } {"}]}';
  assert.deepEqual(
    parseFirstJsonObject(payload + "\n\n(Omitted 1 bytes. Full ...)"),
    JSON.parse(payload),
  );
  assert.throws(() => parseFirstJsonObject('{"a": '), /GEA_CATALOG_TRUNCATED/);
});

test("catalog fact reminder retains actual SKU members and prioritizes quantity units", () => {
  const summary = catalogFactSummary(
    "GEA 网关语义模型成员\n维度：inv.material_code, inv.material_name\n" +
      Array.from({ length: 8 }, (_, i) => "inv.metric" + i + "_count 语义：单位：行").join("\n") +
      "\ninv.available_qty_sum 语义：可用库存，单位件，单快照。",
  );
  const data = JSON.parse(summary);
  assert.deepEqual(data.returnedSkuMembers, ["inv.material_code", "inv.material_name"]);
  assert.match(summary, /available_qty_sum/);
  assert.match(summary, /单位件/);
  assert.equal(catalogFactSummary("permission denied"), "");
});
