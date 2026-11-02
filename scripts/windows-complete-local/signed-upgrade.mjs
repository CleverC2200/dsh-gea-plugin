import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

assert.equal(process.platform, "win32");
const [core, gea] = process.argv.slice(2).map((path) => resolve(path));
const desktop = join(core, "apps/desktop");
const target = join(desktop, ".desktop-build/targets/win-x64");
const output = join(target, "gea-local/signed-upgrade");
await mkdir(output);
const build = JSON.parse(await readFile(join(target, "gea-local/result.json"), "utf8"));
assert.equal(build.unsigned, false);
const signed = join(target, "artifacts", build.artifact);
const certificate = join(gea, "desktop/build/codesign.cer");
const baseline = join(output, "previous-unsigned.exe");
const response = await fetch(
  "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/b0494cb5199055d060a3b5b3ab0d3ab28ab15748/desktop/GEA-Desktop-0.2.0-rc.2.20261102.2-win-x64-complete-local-unsigned.exe",
  { redirect: "error", signal: AbortSignal.timeout(180000) },
);
assert.equal(response.status, 200);
assert.equal(Number(response.headers.get("content-length")), 317784116);
await pipeline(Readable.fromWeb(response.body), createWriteStream(baseline, { flags: "wx" }));
const digest = createHash("sha256");
for await (const data of createReadStream(baseline)) digest.update(data);
assert.equal(
  digest.digest("hex"),
  "88fe295a41a820acd3d5b642fdcf2318357d6ac1dab181f82857d74652c52895",
);
const run = promisify(execFile);
async function execute(name, command, args) {
  try {
    const { stdout, stderr } = await run(command, args, {
      cwd: desktop,
      env: process.env,
      timeout: 600000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    await writeFile(join(output, `${name}.log`), stdout + stderr);
  } catch (error) {
    await writeFile(
      join(output, `${name}.log`),
      String(error.stdout ?? "") + String(error.stderr ?? ""),
    );
    throw Error(`${name} failed; see its retained log`);
  }
}
await execute("publisher-verification", process.execPath, [
  join(desktop, "scripts/test-windows-update-signature.mjs"),
  certificate,
  signed,
  baseline,
]);
await execute("electron-updater-download", process.execPath, [
  join(desktop, "scripts/test-signed-updates.mjs"),
  certificate,
  signed,
  baseline,
]);
await execute("overwrite", "powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  join(gea, "desktop/windows-signed-upgrade.test.ps1"),
  "-OldInstaller",
  baseline,
  "-NewInstaller",
  signed,
  "-WorkDirectory",
  output,
  "-NewVersion",
  build.packaged.version,
  "-CertificatePath",
  certificate,
]);
const qualification = join(desktop, ".desktop-build/qualification");
for (const name of await readdir(qualification)) {
  if (!name.startsWith("signed-downloads-") && !name.startsWith("windows-update-signature-"))
    continue;
  const report = JSON.parse(await readFile(join(qualification, name, "result.json"), "utf8"));
  assert.equal(report.passed, true);
  await writeFile(join(output, `${name}.json`), JSON.stringify(report, null, 2));
}
await writeFile(
  join(output, "result.json"),
  JSON.stringify(
    {
      status: "passed",
      desktopVersion: build.packaged.version,
      installerSha256: build.sha256,
      signedDownloadAndNegativeControls: true,
      unsignedToSignedOverwrite: true,
      existingUserFilesPreserved: true,
      productionFeedDownload: false,
      employeeDeviceAcceptance: false,
    },
    null,
    2,
  ),
);
console.log("Windows signed download and real unsigned-to-signed overwrite passed.");
