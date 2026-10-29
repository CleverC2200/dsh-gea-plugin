import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { encodeOrderReport, decodeOrderReport } from "../src/host/order-report-codec.ts";

test("legacy reports remain readable and compact reports preserve null, zero, strings and row order", async () => {
  const report = {
    schemaVersion: 1,
    facts: {
      rows: [
        { base: "郑州", quantity: 0, price: "0.00000000000001", value: null },
        { base: "华东", quantity: 1.25, price: "9007199254740993", value: false },
      ],
    },
    edits: {
      empty: [{}, {}],
      mixed: [[], {}, null, 0, "a"],
      references: [{ name: "参考链接", url: "https://example.com" }],
    },
  };
  const json = JSON.stringify(report);
  const old = JSON.stringify({ encoding: "gzip-base64", data: gzipSync(json).toString("base64") });
  assert.deepEqual(decodeOrderReport(old), report);
  assert.equal(JSON.stringify(decodeOrderReport(await encodeOrderReport(json))), json);
});
test("large reports use lossless column compression without removing rows or edits", async () => {
  const rows = Array.from({ length: 9000 }, (_, i) => ({
    base: i % 2 ? "郑州" : "华东",
    sku: "SKU-" + i,
    quantity: i * 17.125,
    demand: i * 0.375,
    shortage: i % 19,
    rate: i % 101,
    group: "验证品类" + (i % 12),
    zero: 0,
    missing: null,
    code: String(9007199254740991n + BigInt(i)),
  }));
  const report = {
    schemaVersion: 1,
    facts: { complete: true, rows },
    edits: {
      summary: { positive: "测试结论", risk: "测试风险", rhythm: "测试节奏" },
      empty: [{}, {}],
    },
  };
  const json = JSON.stringify(report),
    encoded = await encodeOrderReport(json);
  assert.equal(JSON.parse(encoded).encoding, "br-columns-v1");
  assert.ok(encoded.length < gzipSync(json).toString("base64").length);
  assert.equal(JSON.stringify(decodeOrderReport(encoded)), json);
});
test("unknown encodings and malformed compressed payloads are rejected", () => {
  assert.throws(() => decodeOrderReport('{"encoding":"unknown","data":""}'), /FORMAT_INVALID/);
  assert.throws(() => decodeOrderReport('{"encoding":"br-columns-v1","data":"broken"}'));
});

test("compression yields to other Host requests and respects the atomic write budget without losing data", async () => {
  const report = {
    schemaVersion: 1,
    facts: {
      complete: true,
      rows: Array.from({ length: 1000 }, (_, index) => ({
        sku: String(index),
        value: createHash("sha256")
          .update("value" + index)
          .digest("hex"),
        reference: createHash("sha256")
          .update("reference" + index)
          .digest("hex"),
      })),
    },
    edits: { summary: { positive: "保留全部内容" } },
  };
  const json = JSON.stringify(report);
  let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 0);
  let encoded;
  try {
    encoded = await encodeOrderReport(json, 125_000);
  } finally {
    clearInterval(timer);
  }
  assert.ok(heartbeats > 0, "compression must leave the Host event loop responsive");
  assert.ok(Buffer.byteLength(encoded) <= 125_000);
  assert.deepEqual(decodeOrderReport(encoded), report);
  const smallest = await encodeOrderReport(json, 1);
  assert.ok(Buffer.byteLength(encoded) >= Buffer.byteLength(smallest));
  assert.deepEqual(decodeOrderReport(smallest), report);
});
