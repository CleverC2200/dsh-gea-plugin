/** Verify one explicit durable Session; fresh live acceptance additionally requires the current Host run. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { zstdDecompressSync, constants } from "node:zlib";

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    session: { type: "string" },
    "require-live": { type: "boolean" },
  },
});
assert.ok(
  values.runtime && values.session,
  "VERIFY_SELECTION_REQUIRED: provide --runtime and --session; historical sessions are never selected automatically",
);
assert.match(values.session, /^session-[a-zA-Z0-9-]+$/);
const runtime = resolve(values.runtime);
const home = resolve(runtime, "home/sessions");
let rows;
for (const workspace of await readdir(home)) {
  let compressed;
  try {
    compressed = await readFile(
      resolve(home, workspace, values.session, "session.v3.jsonl.zstd"),
    );
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  let offset = 0,
    content = "";
  while (offset < compressed.length) {
    const frame = zstdDecompressSync(compressed.subarray(offset), {
      info: true,
      finishFlush: constants.ZSTD_e_flush,
    });
    assert.ok(frame.engine.bytesWritten > 0);
    offset += frame.engine.bytesWritten;
    content += frame.buffer.toString();
  }
  rows = content.trim().split("\n").map(JSON.parse);
  break;
}
assert.ok(rows, "SESSION_NOT_FOUND");
const user = rows.find(
  (row) =>
    row.type === "user/message" &&
    row.data.content?.some(
      (part) =>
        part.type === "text" && part.text.includes("GEA_SNAPSHOT_SHA256="),
    ),
);
assert.ok(user, "SNAPSHOT_NOT_FOUND");
const prompt = user.data.content.find(
  (part) => part.type === "text" && part.text.includes("GEA_SNAPSHOT_SHA256="),
).text;
const expected = prompt.match(/GEA_SNAPSHOT_SHA256=([a-f0-9]{64})/)?.[1];
const json = prompt.slice(prompt.indexOf("\n\n") + 2);
assert.equal(createHash("sha256").update(json).digest("hex"), expected);
const snapshot = JSON.parse(json);
assert.ok(
  ["gea-readonly-v1", "gea-workbench-readonly-v1"].includes(snapshot.format),
  "UNSUPPORTED_SNAPSHOT_FORMAT",
);
const firstTurn = rows.find((row) => row.type === "turn/end");
assert.equal(
  firstTurn?.data.reason.kind,
  "completed",
  "FIRST_ANALYSIS_NOT_COMPLETED",
);
assert.ok(
  rows.indexOf(user) < rows.indexOf(firstTurn),
  "SNAPSHOT_NOT_IN_FIRST_ANALYSIS",
);
const answers = rows.filter(
  (row) =>
    row.type === "assistant/message" &&
    row.data.turn === firstTurn.data.turn &&
    row.data.interrupted !== true,
);
assert.ok(answers.length > 0, "COMPLETE_ANSWER_NOT_FOUND");
let freshLiveVerified = false;
if (values["require-live"]) {
  const log = await readFile(resolve(runtime, "server.log"), "utf8");
  const launch = [...log.matchAll(/dsh web: (http[^\s]+)/g)].at(-1)?.[1];
  assert.ok(launch, "RUNNING_PROFILE_REQUIRED");
  const origin = new URL(launch).origin;
  const exchange = await fetch(launch, { redirect: "manual" });
  const cookie = exchange.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const response = await fetch(origin + "/api/gea-proof/status", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: origin,
    },
    body: "{}",
  });
  const status = await response.json();
  assert.ok(
    status.ok && status.value.authenticated,
    "FRESH_GEA_LOGIN_REQUIRED",
  );
  assert.ok(
    typeof snapshot.runId === "string" && snapshot.runId.length > 0,
    "SNAPSHOT_RUN_REQUIRED",
  );
  assert.equal(
    snapshot.runId,
    status.value.runId,
    "PREVIOUS_PROCESS_NOT_FRESH_ACCEPTANCE",
  );
  assert.equal(
    snapshot.sourceUrl,
    status.value.source + "/sales-plan/plans",
    "SOURCE_URL_MISMATCH",
  );
  assert.equal(snapshot.source, "GEA_LIVE_READONLY", "LIVE_SOURCE_REQUIRED");
  const sourceUrl = new URL(snapshot.sourceUrl);
  assert.ok(
    sourceUrl.protocol === "https:" &&
      !sourceUrl.username &&
      !sourceUrl.password &&
      !sourceUrl.search &&
      !sourceUrl.hash,
    "INVALID_LIVE_SOURCE_URL",
  );
  const hostname = sourceUrl.hostname.replace(/\.$/, "");
  assert.ok(
    hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      !/^127\.\d+\.\d+\.\d+$/.test(hostname) &&
      hostname !== "[::1]",
    "LOCAL_FIXTURE_NOT_LIVE_ACCEPTANCE",
  );
  assert.equal(
    status.value.mode,
    "model",
    "LOCAL_RECEIPT_NOT_MODEL_ACCEPTANCE",
  );
  assert.equal(
    status.value.provider,
    "gea-analysis",
    "GEA_MODEL_PROVIDER_REQUIRED",
  );
  assert.ok(
    typeof status.value.model === "string" && status.value.model.length > 0,
    "CURRENT_MODEL_REQUIRED",
  );
  // Message source records the route that produced the answer; a later model selection is only intent.
  for (const answer of answers) {
    const source = answer.data.message?.source;
    assert.equal(source?.kind, "model", "MODEL_ANSWER_REQUIRED");
    assert.equal(
      source.provider,
      status.value.provider,
      "ANALYSIS_PROVIDER_MISMATCH",
    );
    assert.equal(source.model, status.value.model, "ANALYSIS_MODEL_MISMATCH");
  }
  freshLiveVerified = true;
}
const report = {
  checkedAt: new Date().toISOString(),
  sessionId: values.session,
  snapshotHash: expected,
  snapshotFormat: snapshot.format,
  analysisProvider: answers[0].data.message?.source?.provider ?? null,
  analysisModel: answers[0].data.message?.source?.model ?? null,
  durableSnapshotVerified: true,
  firstAnalysisCompleted: true,
  freshLiveVerified,
};
await writeFile(
  resolve(runtime, "verification.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(report, null, 2));
