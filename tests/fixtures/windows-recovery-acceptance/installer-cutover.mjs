import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { recoverableDirectoryInstaller } from "../../../scripts/windows-complete-local/installer-recovery.mjs";

assert.equal(process.platform, "win32");
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const work = await mkdtemp(join(process.env.RUNNER_TEMP, "dsh-directory-cutover-"));
const core = "17746ac35c8fa08e2da98f2127b05f421132cb16";
const require = createRequire(import.meta.url);
const { getMakeNsisPath } = require("app-builder-lib/out/toolsets/windows.js");
const { getPath7za } = require("app-builder-lib/out/toolsets/7zip.js");
const nsis = await getMakeNsisPath();
const sevenZip = await getPath7za();
const target = join(work, "Application");
const data = join(work, ".dsh");
const payload = join(work, "payload");
const archive = join(work, "new.7z");
const oldMoved = join(work, "old-moved");
const sentinel = { "config.json": '{"setting":"keep"}', "history.jsonl": '{"session":"keep"}\n', "draft.json": '{"draft":"keep"}' };
await Promise.all([target, data, payload].map((directory) => mkdir(directory)));
await writeFile(join(target, "GEA Desktop.exe"), "original program");
await writeFile(join(payload, "GEA Desktop.exe"), "new program");
await Promise.all(Object.entries(sentinel).map(([file, text]) => writeFile(join(data, file), text)));

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 60000, env });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
}
run(sevenZip, ["a", archive, join(payload, "*"), "-bso0", "-bsp0"]);

const url = "https://raw.githubusercontent.com/CleverC2200/deepseek-harness/" + core + "/apps/desktop/scripts/installer-directories.nsh";
const sourceResponse = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
assert.equal(sourceResponse.status, 200);
const source = recoverableDirectoryInstaller(await sourceResponse.text());
const hooks = fileURLToPath(new URL("../../../desktop/build/installer-recovery.nsh", import.meta.url));
const renameCheckpoint = '    StrCpy $dshOldMoved "1"';
assert.equal(source.split(renameCheckpoint).length, 2);

async function compile(installerPath, scriptSource, restoreOnly = false) {
  const included = installerPath + ".nsh";
  await writeFile(included, scriptSource);
  const script = installerPath + ".nsi";
  await writeFile(script, [
    'Unicode true',
    'RequestExecutionLevel user',
    'SilentInstall silent',
    'Name "Desktop directory recovery probe"',
    'OutFile "' + installerPath + '"',
    'LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\English.nlf"',
    'LangString decompressionFailed ${LANG_ENGLISH} "Payload failed"',
    '!define APP_EXECUTABLE_FILENAME "GEA Desktop.exe"',
    '!define INSTALL_REGISTRY_KEY "Software\\SynearGEA\\RecoveryFixture-' + process.pid + '"',
    '!include "' + hooks + '"',
    '!define DSH_SEVENZIP_PATH "' + sevenZip + '"',
    '!macro installApplicationFiles',
    '  !insertmacro dshExtractPayload "' + archive + '"',
    '!macroend',
    '!include "' + included + '"',
    'Section',
    '  InitPluginsDir',
    '  StrCpy $INSTDIR "' + target + '"',
    ...(restoreOnly ? [
      '  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"',
      '  !insertmacro GEA_RESTORE_REGISTERED_DIRECTORY',
      '  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"',
    ] : [
      '  !insertmacro dshStageApplication',
      '  Call dshPromoteDirectories',
      '  IfErrors failed',
      '  !insertmacro dshFinishDirectories',
      '  SetErrorLevel 0',
      '  Quit',
      '  failed:',
      '  SetErrorLevel 2',
      '  Quit',
    ]),
    'SectionEnd',
  ].join("\r\n"));
  run(nsis.path, ["/V2", script], { ...process.env, ...nsis.env });
}

const interrupted = join(work, "interrupt-after-move.exe");
await compile(interrupted, source.replace(renameCheckpoint, renameCheckpoint +
  '\n    FileOpen $9 "' + oldMoved + '" w\n    FileClose $9\n    Sleep 120000'));
const transaction = spawn(interrupted, ["/S"], { windowsHide: true, stdio: "ignore" });
const closed = new Promise((done) => transaction.once("exit", done));
try {
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await readFile(oldMoved); break; }
    catch (error) { if (error.code !== "ENOENT" || Date.now() >= deadline || transaction.exitCode !== null) throw error; }
    await delay(50);
  }
  await assert.rejects(readFile(join(target, "GEA Desktop.exe")), { code: "ENOENT" });
} finally {
  if (transaction.exitCode === null) transaction.kill();
  await closed;
}

const rollbackDeadline = Date.now() + 30000;
for (;;) {
  try {
    assert.equal(await readFile(join(target, "GEA Desktop.exe"), "utf8"), "original program");
    break;
  } catch (error) {
    if (error.code !== "ENOENT" || Date.now() >= rollbackDeadline) throw error;
    await delay(50);
  }
}
assert.equal((await readdir(work)).some((name) => name.startsWith("Application.old-")), false);
const repair = join(work, "standard-overwrite.exe");
await compile(repair, source);
run(repair, ["/S"]);
assert.equal(await readFile(join(target, "GEA Desktop.exe"), "utf8"), "new program");
const registeredRecovery = join(work, "registered-recovery.exe");
const backup = target + ".old-{E8029507-CF56-4BA3-B69A-C638E896F255}";
await rename(target, backup);
await compile(registeredRecovery, source, true);
run(registeredRecovery, ["/S"]);
assert.equal(await readFile(join(target, "GEA Desktop.exe"), "utf8"), "new program");
await assert.rejects(readFile(join(backup, "GEA Desktop.exe")), { code: "ENOENT" });

for (const [file, text] of Object.entries(sentinel)) assert.equal(await readFile(join(data, file), "utf8"), text);
await writeFile(join(output, "official-cutover.json"), JSON.stringify({
  core,
  fault: "installer process terminated between actual old and new directory renames",
  originalShortcutTargetAvailableAfterKill: true,
  oldVersionRestoredWithoutInstallerRerun: true,
  standardInstallerOverwriteRestoredTarget: true,
  coldRecoveryRestoredRegisteredTarget: true,
  dataFilesPreserved: true,
}, null, 2));
