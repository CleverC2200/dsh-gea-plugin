import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function preservedSession(sdk, home) {
  const { Context } = await import(pathToFileURL(join(sdk, "vendor/cordis/lib/index.js")));
  const { default: Persistence } = await import(
    pathToFileURL(join(sdk, "packages/session/session-persistence-jsonl/lib/index.js"))
  );
  const { SESSION_FORMAT_VERSION } = await import(
    pathToFileURL(join(sdk, "packages/core/session/lib/index.js"))
  );
  const root = join(home, "sessions");
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: "update-preservation",
    createdAt: 1000,
    isSeeded: false,
  };
  const events = [
    { type: "turn/start", seq: 0, time: 1001, data: { turn: 1 } },
    {
      type: "user/message",
      surfaceOp: "append",
      seq: 1,
      time: 1002,
      data: {
        id: "kept-message",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "保留这段历史会话" }],
      },
    },
    { type: "turn/end", seq: 2, time: 1003, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const mount = async () => {
    const ctx = new Context();
    await ctx.plugin(Persistence, { root, compression: "none" });
    return ctx;
  };
  const ctx = await mount();
  try {
    const handle = await ctx.sessionPersistence.create(header);
    try {
      await handle.append(events);
      await handle.flush();
    } finally {
      await handle.close();
    }
  } finally {
    await ctx.fiber.dispose();
  }
  const files = (await readdir(root, { recursive: true })).filter((file) =>
    file.endsWith(".jsonl"),
  );
  assert.equal(files.length, 1);
  const path = join(root, files[0]),
    bytes = await readFile(path);
  return async () => {
    assert.deepEqual(await readFile(path), bytes);
    const fresh = await mount();
    try {
      const handle = await fresh.sessionPersistence.open(header.id, "read");
      try {
        assert.deepEqual((await handle.read()).events, events);
      } finally {
        await handle.close();
      }
    } finally {
      await fresh.fiber.dispose();
    }
  };
}
