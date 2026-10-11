import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("missing declared Chromium assets cannot fall back to the machine's Chrome", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gea-browser-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: directory };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {chromium} from '@playwright/test'; const browser=await chromium.launch({headless:true}); await browser.close();",
    ],
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Executable doesn't exist/);
  assert.ok(result.stderr.includes(directory));
});
