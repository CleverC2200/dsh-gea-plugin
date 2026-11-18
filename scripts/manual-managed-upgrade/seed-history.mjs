import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const load = createRequire(join(input.root, "dsh/node_modules/@deepseek-ai/dsh/package.json"));
const { Context } = await import(pathToFileURL(load.resolve("@deepseek-ai/cordis")));
const { default: Persistence } = await import(
  pathToFileURL(load.resolve("@deepseek-ai/dsh-session-persistence-jsonl"))
);
const { Session, SESSION_FORMAT_VERSION } = await import(
  pathToFileURL(load.resolve("@deepseek-ai/dsh-session"))
);
const queryLoad = createRequire(load.resolve("@deepseek-ai/dsh-session-query"));
const { currentSessionMessageProjections } = await import(
  pathToFileURL(queryLoad.resolve("@deepseek-ai/dsh-session-format-catalog/message-projections"))
);
assert(isAbsolute(input.cwd), "HISTORICAL_SESSION_WORKING_DIRECTORY_REQUIRED");
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
      content: [{ type: "text", text: "Native upgrade preservation history" }],
    },
  },
  { type: "turn/end", seq: 2, time: 1003, data: { turn: 1, reason: { kind: "completed" } } },
];
const ctx = new Context();
try {
  await ctx.plugin(Persistence, { root: join(input.home, "sessions") });
  if (input.mode === "create") {
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: input.sessionId,
      createdAt: 1000,
      cwd: input.cwd,
      isSeeded: false,
    });
    try {
      await handle.append(events);
      await handle.flush();
    } finally {
      await handle.close();
    }
  }
  const snapshots = await ctx.sessionPersistence.list();
  assert(
    snapshots.some((snapshot) => snapshot.header.id === input.sessionId),
    "HISTORICAL_SESSION_NOT_LISTED",
  );
  const handle = await ctx.sessionPersistence.open(input.sessionId, "read");
  try {
    const stored = await handle.read();
    assert.equal(handle.header.cwd, input.cwd);
    assert.deepEqual(
      stored.events.filter((event) => event.seq <= 2),
      events,
    );
    Session.create(
      input.sessionId,
      stored.events,
      handle.header,
      handle.inheritedEventCount,
      currentSessionMessageProjections,
    );
  } finally {
    await handle.close();
  }
} finally {
  await ctx.fiber.dispose();
}
console.log(
  JSON.stringify({
    status: input.mode === "create" ? "history-created-and-read-back" : "history-preserved",
    sessionId: input.sessionId,
  }),
);
