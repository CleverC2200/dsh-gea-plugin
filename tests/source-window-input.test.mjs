import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// Observe the public fixture in a fresh process. Product admission has no test-only bypass.
async function probe(t, input) {
  let inputFile;
  if (input !== undefined) {
    const directory = await mkdtemp(join(tmpdir(), "source-window-input-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    inputFile = join(directory, "candidate.json");
    await writeFile(inputFile, JSON.stringify(input));
  }
  const environment = { ...process.env };
  delete environment.GEA_TEST_CANDIDATE_INPUTS;
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import fs from 'node:fs';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const effects=[],cleanup=[];
for(const operation of ['mkdtemp','mkdir','writeFile','appendFile','cp','copyFile','symlink','rename','unlink','rm']){
 const original=fs.promises[operation];
 fs.promises[operation]=function(...args){effects.push({operation,path:String(args[0])});return original.apply(this,args);};
}
for(const operation of ['mkdtempSync','mkdirSync','writeFileSync','appendFileSync','cpSync','copyFileSync','symlinkSync','renameSync','unlinkSync','rmSync']){
 const original=fs[operation];
 fs[operation]=function(...args){effects.push({operation,path:String(args[0])});return original.apply(this,args);};
}
const writes=flags=>typeof flags==='number'?Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)):/[wax+]/.test(flags);
for(const [target,operation] of [[fs,'openSync'],[fs.promises,'open']]){
 const original=target[operation];
 target[operation]=function(...args){if(writes(args[1]))effects.push({operation,path:String(args[0])});return original.apply(this,args);};
}
for(const operation of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']){
 const original=child[operation];
 child[operation]=function(...args){effects.push({operation:'process:'+operation,path:String(args[0])});return original.apply(this,args);};
}
syncBuiltinESMExports();
const {sourceWindow}=await import(${JSON.stringify(new URL("./fixtures/source-window.mjs", import.meta.url).href)});
let error;
try {await sourceWindow({after:fn=>cleanup.push(fn)},'source-host',${JSON.stringify(inputFile ? { inputFile } : {})});}
catch(value){error={code:value.code,message:value.message};}
const report={error,effects:structuredClone(effects)};
for(const dispose of cleanup)await dispose();
console.log(JSON.stringify(report));
`,
    ],
    { encoding: "utf8", env: environment, timeout: 20000 },
  );
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.effects, [], JSON.stringify(report));
  return report.error?.message;
}

test("missing fixed inputs refuse before creating any temporary or runtime state", async (t) => {
  assert.match(await probe(t), /SOURCE_WINDOW_INPUT_REQUIRED/);
});

test("a declared file without fixed Core refuses before filesystem mutation", async (t) => {
  assert.match(await probe(t, {}), /SOURCE_WINDOW_CORE_REQUIRED/);
});

const pinned = { core: "a".repeat(40), corePath: join(tmpdir(), "declared-core") };
test("the owner set is explicit before looking for SDK or peer checkouts", async (t) => {
  assert.match(await probe(t, pinned), /SOURCE_WINDOW_OWNER_REQUIRED: dsh-agent-workbench/);
});

const owners = ["dsh-agent-workbench", "dsh-agent-manage", "dsh-gea-plugin"].map((repo) => ({
  repo,
  path: join(tmpdir(), repo),
  head: "b".repeat(40),
}));
test("duplicate owners refuse instead of selecting the nearest checkout", async (t) => {
  assert.match(
    await probe(t, { ...pinned, repositories: [...owners, owners[0]] }),
    /SOURCE_WINDOW_OWNER_REQUIRED/,
  );
});

test("historical failure bytes need an explicit path and digest before preparation", async (t) => {
  assert.match(
    await probe(t, { ...pinned, repositories: owners }),
    /SOURCE_WINDOW_HISTORY_REQUIRED/,
  );
});

test("a stale historical digest refuses before candidate checks or preparation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "source-window-history-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "failure.json");
  await writeFile(file, '{"businessRequests":"unknown"}');
  assert.match(
    await probe(t, {
      ...pinned,
      repositories: owners,
      historicalFailure: { file, sha256: "0".repeat(64) },
    }),
    /SOURCE_WINDOW_HISTORY_DIGEST_MISMATCH/,
  );
});

test("a different declared GEA checkout refuses before candidate processes or filesystem mutation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "source-window-other-checkout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "failure.json");
  const bytes = '{"businessRequests":"unknown"}';
  await writeFile(file, bytes);
  const repositories = owners.map((owner) =>
    owner.repo === "dsh-gea-plugin" ? { ...owner, path: directory } : owner,
  );
  assert.match(
    await probe(t, {
      ...pinned,
      repositories,
      historicalFailure: { file, sha256: createHash("sha256").update(bytes).digest("hex") },
    }),
    /SOURCE_WINDOW_CHECKOUT_MISMATCH/,
  );
});
