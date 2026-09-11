import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("keyless approval workspace snapshot preserves selected identifiers and event order", async () => {
  const path = fileURLToPath(new URL("./fixtures/gea-approval-workspace.snapshot.json", import.meta.url));
  const snapshot = JSON.parse(await readFile(path, "utf8"));
  assert.equal(snapshot.source, "GEA_LIVE_READONLY");
  assert.deepEqual(snapshot.events, ["query", "select", "preview", "submit", "receipt"]);
  assert.equal(snapshot.selected.planId, "9007199254740993");
  assert.equal(snapshot.selected.currentQty, "1.2300");
  assert.equal(snapshot.selected.targetAmount, "12.30");
  assert.equal(Object.hasOwn(snapshot, "accessToken"), false);
});
