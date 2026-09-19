import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDesktopPackage } from "./package-desktop.mjs";

test("desktop package validation requires a platform payload", async t => {
  const root = await mkdtemp(join(tmpdir(), "gea-package-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "mac", "payload"), { recursive: true });
  await assert.doesNotReject(() => validateDesktopPackage({ target: "mac", payloadRoot: root }));
  await assert.rejects(() => validateDesktopPackage({ target: "win", payloadRoot: root }), /payload for win/);
});

test("desktop package validation rejects unknown targets", async () => {
  await assert.rejects(() => validateDesktopPackage({ target: "linux", payloadRoot: tmpdir() }), /INVALID_DESKTOP_TARGET/);
});
