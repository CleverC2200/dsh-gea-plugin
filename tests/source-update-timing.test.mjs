import test from "node:test";
import assert from "node:assert/strict";
import { measureSourceUpdate } from "./fixtures/source-update-timing.mjs";

test("source update timing preserves a successful result when diagnostics are unavailable", async () => {
  const value = { phase: "succeeded" };
  const context = {
    name: "timing success",
    diagnostic() {
      throw new Error("diagnostic output unavailable");
    },
  };
  assert.equal(await measureSourceUpdate(context, "baseline", "load", async () => value), value);
});

test("source update timing preserves the original failure and records its phase", async () => {
  const original = new Error("SOURCE_DEPENDENCY_DIGEST_MISMATCH");
  const records = [];
  const context = { name: "timing failure", diagnostic: (text) => records.push(JSON.parse(text)) };
  await assert.rejects(
    measureSourceUpdate(context, "gea-updated", "update", async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(records.at(-1).phase, "gea-updated");
  assert.equal(records.at(-1).step, "update");
  assert.equal(records.at(-1).status, "failed");
});
