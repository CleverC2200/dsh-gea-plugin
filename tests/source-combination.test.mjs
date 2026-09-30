import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  readSourceCombination,
  selectSourceCombination,
} from "../scripts/source-profile.mjs";

test("selection rejects changed resources and a running Host, preserving the last selected combination", async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), "source-combination-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const id = randomUUID(),
    dir = join(runtime, "source-combinations", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "page.html"), "current page");
  await writeFile(
    join(dir, "combination.json"),
    JSON.stringify({
      composition: { id },
      files: {
        "page.html": createHash("sha256").update("current page").digest("hex"),
      },
    }),
  );
  await selectSourceCombination(runtime, id);
  const selected = await readFile(
    join(runtime, "source-selection.json"),
    "utf8",
  );
  await writeFile(join(runtime, "source-profile.lock"), "Host running");
  await assert.rejects(selectSourceCombination(runtime, id), {
    code: "EEXIST",
  });
  await rm(join(runtime, "source-profile.lock"));
  await writeFile(join(dir, "page.html"), "changed page");
  await assert.rejects(readSourceCombination(runtime, id), /DIGEST_MISMATCH/);
  await assert.rejects(selectSourceCombination(runtime, id), /DIGEST_MISMATCH/);
  assert.equal(
    await readFile(join(runtime, "source-selection.json"), "utf8"),
    selected,
  );
  await assert.rejects(
    readSourceCombination(runtime, "../../outside"),
    /INVALID_SOURCE_COMBINATION/,
  );
});
