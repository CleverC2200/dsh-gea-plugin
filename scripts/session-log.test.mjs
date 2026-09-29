import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { readSessionRows } from "./session-log.mjs";

test("verification reads the newest supported generation", async t => {
  const root = await mkdtemp(join(tmpdir(), "gea-log-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "home/sessions/workspace/session-example");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "session.v3.jsonl.zstd"), zstdCompressSync(Buffer.from('{"value":"old"}\n')));
  await writeFile(join(directory, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from('{"value":"current"}\n')));
  assert.deepEqual(await readSessionRows(root, "session-example"), [{ value: "current" }]);
});

test("verification refuses a future generation instead of accepting an older answer", async t => {
  const root = await mkdtemp(join(tmpdir(), "gea-log-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "home/sessions/workspace/session-example");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "session.v3.jsonl.zstd"), zstdCompressSync(Buffer.from('{"value":"old"}\n')));
  await writeFile(join(directory, "session.v5.jsonl.zstd"), zstdCompressSync(Buffer.from('{"value":"future"}\n')));
  await assert.rejects(readSessionRows(root, "session-example"), /UNSUPPORTED_SESSION_GENERATION: 5/);
});
