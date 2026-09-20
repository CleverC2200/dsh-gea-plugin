import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHELL_FILES, validateDesktopPackage } from "./package-desktop.mjs";

const desktop = join(import.meta.dirname, "..", "desktop");

test("every module the Electron main process requires ships in app.asar", async () => {
  // prepareStaging writes its own package.json next to the shell files.
  const shipped = new Set([...SHELL_FILES, "package.json"]);
  const missing = [];
  for (const name of SHELL_FILES) {
    if (!/\.(cjs|mjs|js)$/.test(name)) continue;
    const source = await readFile(join(desktop, name), "utf8");
    for (const [, target] of source.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g))
      if (!shipped.has(target)) missing.push(`${name} -> ${target}`);
  }
  assert.deepEqual(missing, [], "add these files to SHELL_FILES in scripts/package-desktop.mjs");
});

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
