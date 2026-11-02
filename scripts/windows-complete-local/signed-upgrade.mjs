import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

assert.equal(process.platform, "win32");
const [core, gea] = process.argv.slice(2, 4).map((path) => resolve(path));
const overwriteOnly = process.argv[6] === "overwrite-only";
const desktop = join(core, "apps/desktop");
const target = process.argv[4]
  ? resolve(process.argv[4])
  : join(desktop, ".desktop-build/targets/win-x64");
const output = process.argv[5]
  ? resolve(process.argv[5])
  : join(target, "gea-local/signed-upgrade");
await mkdir(output);
const build = JSON.parse(await readFile(join(target, "gea-local/result.json"), "utf8"));
assert.equal(build.unsigned, false);
const signed = join(target, "artifacts", build.artifact);
const certificate = join(gea, "desktop/build/codesign.cer");
if (overwriteOnly) {
  assert.match(process.env.GEA_QUALIFICATION_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(build.geaSha, process.env.GEA_QUALIFICATION_SOURCE_SHA);
}
assert.equal(
  new X509Certificate(await readFile(certificate)).fingerprint256,
  build.windowsSigning.fingerprint,
);
async function fileSha(path) {
  const digest = createHash("sha256");
  for await (const data of createReadStream(path)) digest.update(data);
  return digest.digest("hex");
}
assert.equal(await fileSha(signed), build.sha256);
const baseline = join(output, "previous-unsigned.exe");
const response = await fetch(
  "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/b0494cb5199055d060a3b5b3ab0d3ab28ab15748/desktop/GEA-Desktop-0.2.0-rc.2.20261102.2-win-x64-complete-local-unsigned.exe",
  { redirect: "error", signal: AbortSignal.timeout(180000) },
);
assert.equal(response.status, 200);
assert.equal(Number(response.headers.get("content-length")), 317784116);
await pipeline(Readable.fromWeb(response.body), createWriteStream(baseline, { flags: "wx" }));
assert.equal(
  await fileSha(baseline),
  "88fe295a41a820acd3d5b642fdcf2318357d6ac1dab181f82857d74652c52895",
);
const run = promisify(execFile);
async function execute(name, command, args) {
  try {
    const { stdout, stderr } = await run(command, args, {
      cwd: overwriteOnly ? gea : desktop,
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
if (!overwriteOnly) {
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
} else {
  await execute("trust-public-certificate", "powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(gea, "desktop/build/install-certificate.ps1"),
    "-CertificatePath",
    certificate,
    "-StoreLocation",
    "LocalMachine",
  ]);
}
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
if (!overwriteOnly) {
  const qualification = join(desktop, ".desktop-build/qualification");
  for (const name of await readdir(qualification)) {
    if (!name.startsWith("signed-downloads-") && !name.startsWith("windows-update-signature-"))
      continue;
    const report = JSON.parse(await readFile(join(qualification, name, "result.json"), "utf8"));
    assert.equal(report.passed, true);
    await writeFile(join(output, `${name}.json`), JSON.stringify(report, null, 2));
  }
}
await writeFile(
  join(output, "result.json"),
  JSON.stringify(
    {
      status: "passed",
      desktopVersion: build.packaged.version,
      installerSha256: build.sha256,
      signedDownloadAndNegativeControls: !overwriteOnly,
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
