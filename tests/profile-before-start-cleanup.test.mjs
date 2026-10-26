import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { profile } from "./profile.mjs";

test("cancelled profile cleanup joins beforeStart before disposing its runtime", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gea-before-start-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "launcher-started");
  const launcher = join(directory, "launcher.mjs");
  await writeFile(
    launcher,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started');`,
  );
  const controller = new AbortController();
  const reason = new Error("beforeStart cancelled");
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let cleanup;
  const completion = profile(
    {
      name: t.name,
      signal: controller.signal,
      after: (fn) => {
        cleanup = fn;
      },
    },
    {
      coreOnly: true,
      runtimeParent: directory,
      execArgv: [launcher],
      beforeStart: async ({ runtime, config }) => {
        await mkdir(runtime, { recursive: true });
        entered.resolve({ runtime, directory: dirname(config) });
        await gate.promise;
      },
    },
  ).then(
    () => ({ returned: true }),
    (error) => ({ error }),
  );
  const owned = await Promise.race([
    entered.promise,
    completion.then((result) => {
      if (result.error) throw result.error;
      throw new Error("profile returned before entering beforeStart");
    }),
  ]);
  controller.abort(reason);
  const disposing = cleanup();
  try {
    const state = await Promise.race([
      disposing.then(() => "disposed"),
      delay(100).then(() => "waiting"),
    ]);
    assert.equal(state, "waiting", "cleanup resolved while beforeStart still owned the runtime");
    await access(owned.directory);
    await access(owned.runtime);
    gate.resolve();
    assert.equal(
      (await completion).error,
      reason,
      "profile must preserve the original cancellation",
    );
    await disposing;
    await assert.rejects(access(marker), { code: "ENOENT" });
    await assert.rejects(access(owned.directory), { code: "ENOENT" });
    await assert.rejects(access(owned.runtime), { code: "ENOENT" });
  } finally {
    gate.resolve();
    await completion;
    await disposing;
  }
});

for (const asynchronous of [false, true]) {
  test(`profile retains ${asynchronous ? "asynchronous" : "synchronous"} beforeStart failure through cleanup`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "gea-before-start-failure-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const reason = new Error("beforeStart failed");
    let cleanup;
    const fail = () => {
      throw reason;
    };
    await assert.rejects(
      profile(
        {
          name: t.name,
          after: (fn) => {
            cleanup = fn;
          },
        },
        {
          coreOnly: true,
          runtimeParent: directory,
          beforeStart: asynchronous ? async () => fail() : fail,
        },
      ),
      (error) => error === reason,
    );
    await cleanup();
  });
}

test("profile cancellation before source preparation preserves the case cancellation without reading unused inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gea-source-before-start-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const reason = Error("case cancelled before immutable preparation");
  let cleanup;
  try {
    await assert.rejects(
      profile(
        {
          name: t.name,
          signal: controller.signal,
          after: (fn) => {
            cleanup = fn;
          },
        },
        {
          runtimeParent: directory,
          sourcesFile: join(directory, "not-prepared.json"),
          beforeStart: () => controller.abort(reason),
        },
      ),
      (error) => error === reason,
    );
  } finally {
    await cleanup?.();
  }
});
