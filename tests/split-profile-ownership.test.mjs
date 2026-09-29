import test from "node:test";
import assert from "node:assert/strict";
import { installPromptProfile, profileFor } from "../src/host/prompt-policy.ts";
test("a split persona refuses overlapping owners and stale disposal cannot replace its successor", () => {
  const preset = "gea-html-inventory-fc",
    original = profileFor(preset);
  const first = { ...original, persona: "first" },
    second = { ...original, persona: "second" };
  const off = installPromptProfile(preset, first);
  try {
    assert.throws(
      () => installPromptProfile(preset, second),
      /ALREADY_MOUNTED/,
    );
    assert.equal(profileFor(preset), first);
  } finally {
    off();
  }
  const next = installPromptProfile(preset, second);
  try {
    off();
    assert.equal(profileFor(preset), second);
  } finally {
    next();
  }
  assert.equal(profileFor(preset), original);
});
