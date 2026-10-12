import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
const helper = new URL("./fixtures/source-test.mjs", import.meta.url).href;
async function execute(t, body, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "gea-source-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = join(root, "cleanup.json"),
    fixture = join(root, "case.mjs");
  await writeFile(
    fixture,
    `import test,{withSourceSetup} from ${JSON.stringify(helper)};
import {setTimeout as delay} from 'node:timers/promises';import {writeFile} from 'node:fs/promises';
let producerStarts=0;const parent=new AbortController();${options.parent ? "setTimeout(()=>parent.abort(Error('PARENT_CANCELLED')),100);" : ""}
test('bounded Source fixture',{timeout:${options.action ?? 200},sourceSetupTimeoutMs:${options.setup ?? 100}${options.setupCount === undefined ? "" : ",sourceSetupCount:" + (typeof options.setupCount === "number" ? String(options.setupCount) : JSON.stringify(options.setupCount))},signal:parent.signal},async t=>{
 t.after(()=>writeFile(${JSON.stringify(receipt)},JSON.stringify({aborted:t.signal.aborted,reason:t.signal.reason?.message,reasonName:t.signal.reason?.name,producerStarts})));
 ${body}
});`,
  );
  const env = { ...process.env, GEA_TEST_SOURCE_CORE: "1" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--test", fixture], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => (output += bytes));
  const [status, signal] = await once(child, "exit");
  let cleanup;
  try {
    cleanup = JSON.parse(await readFile(receipt, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { status, signal, output, cleanup };
}
test("Source setup exhaustion aborts the public Node signal and joins cleanup", async (t) => {
  const result = await execute(
    t,
    "await withSourceSetup(t,()=>delay(300,undefined,{signal:t.signal}));",
  );
  assert.equal(result.status, 1);
  assert.match(result.output, /SOURCE_SETUP_TIMEOUT/);
  assert.equal(result.cleanup.aborted, true);
  assert.equal(result.cleanup.reasonName, "AbortError");
});
test("Source action exhaustion retains the original case deadline", async (t) => {
  const result = await execute(
    t,
    "await withSourceSetup(t,()=>delay(20));await delay(400,undefined,{signal:t.signal});",
  );
  assert.equal(result.status, 1);
  assert.match(result.output, /SOURCE_ACTION_TIMEOUT/);
  assert.equal(result.cleanup.aborted, true);
});
test("parent cancellation reaches the same public signal during Source preparation", async (t) => {
  const result = await execute(
    t,
    "await withSourceSetup(t,()=>delay(300,undefined,{signal:t.signal}));",
    { parent: true },
  );
  assert.equal(result.status, 1);
  assert.equal(result.cleanup.aborted, true);
  assert.match(result.output, /PARENT_CANCELLED/);
  assert.equal(result.cleanup.reasonName, "AbortError");
});
test("timely Source setup and action complete without a leftover timer", async (t) => {
  const result = await execute(t, "await withSourceSetup(t,()=>delay(60));await delay(10);", {
    action: 40,
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.signal, null);
});
test("Source budget handling never swallows the original cleanup failure", async (t) => {
  const result = await execute(
    t,
    "t.after(()=>{throw Error('ORIGINAL_CLEANUP_FAILED')});await withSourceSetup(t,()=>delay(20));",
  );
  assert.equal(result.status, 1);
  assert.match(result.output, /ORIGINAL_CLEANUP_FAILED/);
});

test("declared repeated Source setup fits its finite Node guard", async (t) => {
  const result = await execute(
    t,
    "for(let i=0;i<4;i++) await withSourceSetup(t,()=>delay(200,undefined,{signal:t.signal}));await delay(50,undefined,{signal:t.signal});",
    { action: 400, setup: 300, setupCount: 4 },
  );
  assert.equal(result.status, 0, result.output);
  assert.equal(result.cleanup.aborted, false);
});

test("a declared Source setup count rejects the next producer before it starts", async (t) => {
  const result = await execute(
    t,
    "for(let i=0;i<5;i++) await withSourceSetup(t,async()=>{producerStarts++;await delay(10)});",
    { action: 500, setupCount: 4 },
  );
  assert.equal(result.status, 1);
  assert.match(result.output, /SOURCE_SETUP_COUNT_EXCEEDED/);
  assert.equal(result.cleanup.producerStarts, 4);
});

test("Source setup declarations reject invalid counts before the case body", async (t) => {
  for (const setupCount of [
    0,
    -1,
    NaN,
    Infinity,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "4",
    true,
    null,
  ]) {
    const result = await execute(t, "throw Error('PRODUCER_MUST_NOT_START');", { setupCount });
    assert.equal(result.status, 1);
    assert.match(result.output, /SOURCE_SETUP_COUNT_INVALID/);
    assert.doesNotMatch(result.output, /PRODUCER_MUST_NOT_START/);
  }
});

test("repeated Source setup preserves the aggregate action deadline", async (t) => {
  const result = await execute(
    t,
    "for(let i=0;i<4;i++){await withSourceSetup(t,()=>delay(30,undefined,{signal:t.signal}));await delay(70,undefined,{signal:t.signal});}",
    { setupCount: 4 },
  );
  assert.equal(result.status, 1);
  assert.match(result.output, /SOURCE_ACTION_TIMEOUT/);
  assert.equal(result.cleanup.aborted, true);
});
test("a later declared Source setup retains its individual deadline", async (t) => {
  const result = await execute(
    t,
    "await withSourceSetup(t,()=>delay(10));await withSourceSetup(t,()=>delay(300,undefined,{signal:t.signal}));",
    { setupCount: 4 },
  );
  assert.equal(result.status, 1);
  assert.match(result.output, /SOURCE_SETUP_TIMEOUT/);
  assert.equal(result.cleanup.aborted, true);
});
test("nested Source preparation consumes only its outer declaration", async (t) => {
  const result = await execute(
    t,
    "for(let i=0;i<4;i++) await withSourceSetup(t,()=>withSourceSetup(t,async()=>{producerStarts++;await delay(10)}));",
    { action: 500, setupCount: 4 },
  );
  assert.equal(result.status, 0, result.output);
  assert.equal(result.cleanup.producerStarts, 4);
});
test("undeclared repeated Source setup keeps the existing count behavior", async (t) => {
  const result = await execute(
    t,
    "for(let i=0;i<4;i++) await withSourceSetup(t,async()=>{producerStarts++;await delay(10)});",
    { action: 500 },
  );
  assert.equal(result.status, 0, result.output);
  assert.equal(result.cleanup.producerStarts, 4);
});
