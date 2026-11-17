import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { signAdHocRuntime } from "./ad-hoc.mjs";

test("candidate signer preserves ordinary runtime files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gea-ad-hoc-text-"));
  t.after(() => rm(root, { recursive: true }));
  const path = join(root, "data.txt");
  await writeFile(path, "runtime data");
  assert.equal(await signAdHocRuntime(root, "not-used"), 0);
  assert.equal(await readFile(path, "utf8"), "runtime data");
});

test(
  "candidate signs a real Mach-O without Developer ID credentials",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "gea-ad-hoc-native-"));
    t.after(() => rm(root, { recursive: true }));
    const path = join(root, "true");
    await copyFile("/usr/bin/true", path);
    const entitlements = join(root, "entitlements.plist");
    await writeFile(
      entitlements,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',
    );
    assert.equal(await signAdHocRuntime(root, entitlements), 1);
    const details = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", path], {
      encoding: "utf8",
    });
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", path]);
    assert.equal(details.status, 0);
    assert.match(details.stderr, /Signature=adhoc/);
  },
);
