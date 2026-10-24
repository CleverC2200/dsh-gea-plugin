import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { installCommands } from "./quality-worker-inputs.mjs";

const root = process.env.RUNNER_TEMP;
const record = root + "/s1-root-child.json";
const rootCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,euid:process.geteuid()}));setInterval(()=>{},1000);`;
const parentCode = `require('node:child_process').spawn('sudo',['-n',process.execPath,'-e',${JSON.stringify(rootCode)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
const owned = installCommands({ errorCode: "S1_EXPECTED_TIMEOUT" });
const started = Date.now();
let error;
try {
  await owned.run(process.execPath, ["-e", parentCode], root, {
    timeoutMs: 1500,
    rootGroupCleanup: true,
    forwardOutput: true,
  });
} catch (failure) {
  error = failure.message;
} finally {
  await owned.close();
}
assert.ok(error, "the hung installer must fail");
assert.match(error, /1500|budget|timeout|deadline/i);
const child = JSON.parse(readFileSync(record));
assert.equal(child.euid, 0, "the installed descendant must really be root");
const alive = spawnSync("sudo", ["-n", "kill", "-0", String(child.pid)], { encoding: "utf8" });
assert.notEqual(alive.status, 0, "root descendant survived cleanup");
const result = { status: "passed", error, child, descendantAlive: false, elapsedMs: Date.now() - started };
writeFileSync(root + "/s1-root-evidence/result.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
