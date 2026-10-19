import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
const originalExecute = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
let diagnosticPhase = "initializing";
const calls = [];
export const sourceBindings = {
  runnerSha256: "d62f904f0d52f9e364f87c0c1ac0813fb4b65bcf59dd5f921dd91df2916a9932",
  privacySha256: "d809e5c740c58369f913b7d8a23a5909fb18de31d13fa68e1d40011dc8d3034e",
  ownerFunctionSha256: "3e6095223c0d9cbb56f5c5c0529672a33cd0f70c9b0176febdc2c3675b46f87f",
  verifierFunctionSha256: "a0a1c2be12454f561272c2302cd656df06d7d442055dad97087b0e2d8cc0a45c",
};
export function subprocessFacts(error, elapsedMs, stdout = "") {
  const codes = ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ERR_ASSERTION"];
  return {
    elapsedMs: Math.round(elapsedMs),
    errorName: error
      ? ["Error", "AssertionError", "TimeoutError"].includes(error.name)
        ? error.name
        : "Error"
      : null,
    code: !error
      ? 0
      : Number.isInteger(error.code)
        ? error.code
        : codes.includes(error.code)
          ? error.code
          : "unclassified",
    killed: error?.killed === true,
    signal: ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"].includes(error?.signal)
      ? error.signal
      : null,
    ownerOnlyOutput: stdout.trim() === "OWNER_ONLY",
    stdoutPresent: Boolean(stdout),
    stderrPresent: Boolean(error?.stderr),
    parserErrorMentioned: /ParserError|ParseException/.test(error?.stderr ?? ""),
    stderrCommandMentions: ["Get-Acl", "Write-Output", "ConvertTo-Json"].filter((name) =>
      (error?.stderr ?? "").toLowerCase().includes(name.toLowerCase()),
    ),
  };
}
const execute = async (file, args, options) => {
  const started = performance.now();
  try {
    const value = await originalExecute(file, args, options);
    calls.push({
      phase: diagnosticPhase,
      commandSha256: hash(args.at(-1)),
      ...subprocessFacts(null, performance.now() - started, value.stdout),
    });
    return value;
  } catch (error) {
    calls.push({
      phase: diagnosticPhase,
      commandSha256: hash(args.at(-1)),
      ...subprocessFacts(error, performance.now() - started, error.stdout ?? ""),
    });
    throw error;
  }
};
async function secureDirectory(path) {
  diagnosticPhase = "secure-owner-create";
  await mkdir(path, { recursive: false, mode: 0o700 });
  if (process.platform !== "win32") {
    await assertPrivate(path);
    return;
  }
  const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  diagnosticPhase = "secure-owner-identity";
  const me = (
    await execute(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { windowsHide: true },
    )
  ).stdout.trim();
  assert(/^S-1-(?:\d+-)+\d+$/.test(me), "WINDOWS_OWNER_SID_REQUIRED");
  diagnosticPhase = "secure-owner-acl-apply";
  const command =
    "$ErrorActionPreference='Stop'; $me=[Security.Principal.SecurityIdentifier]::new($env:R9_OWNER_SID); $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18'); $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true, $false); $acl.SetOwner($me); foreach($identity in @($me,$system)){ $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)) }; [IO.Directory]::SetAccessControl($env:R9_PRIVATE_PATH, $acl)";
  await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, R9_PRIVATE_PATH: path, R9_OWNER_SID: me },
    windowsHide: true,
  });
  diagnosticPhase = "secure-owner-verify";
  await assertPrivate(path);
}
export async function assertPrivate(path) {
  if (process.platform !== "win32") {
    const mode = (await stat(path)).mode & 0o777;
    assert([0o600, 0o700].includes(mode), "PRIVATE_POSIX_MODE_REQUIRED");
    return;
  }
  const command =
    "$ErrorActionPreference='Stop'; $path=$env:R9_PRIVATE_PATH; $attributes=[IO.File]::GetAttributes($path); if(($attributes -band [IO.FileAttributes]::Directory) -ne 0){$acl=[IO.Directory]::GetAccessControl($path)}else{$acl=[IO.File]::GetAccessControl($path)}; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -ne $me -and $rule.IdentityReference.Value -ne 'S-1-5-18'){exit 3}}; [Console]::Out.WriteLine('OWNER_ONLY')";
  const result = await execute(
    join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { env: { ...process.env, R9_PRIVATE_PATH: path }, windowsHide: true, timeout: 10000 },
  );
  assert.equal(result.stdout.trim(), "OWNER_ONLY", "PRIVATE_WINDOWS_ACL_REQUIRED");
}
export function aclCasePassed(facts, expectedCode) {
  return (
    facts.code === expectedCode &&
    facts.killed === false &&
    facts.signal === null &&
    facts.ownerOnlyOutput === (expectedCode === 0)
  );
}
export const commandNames = [
  "Get-NetTCPConnection",
  "Get-CimInstance",
  "Where-Object",
  "Select-Object",
  "ConvertTo-Json",
];
export function readCommandAvailability(text) {
  const lines = new Map(text.split(/\r?\n/).map((line) => line.split("=")));
  return Object.fromEntries(
    commandNames.map((name) => [
      name,
      lines.get(name) === "True" ? true : lines.get(name) === "False" ? false : null,
    ]),
  );
}
async function main() {
  assert.equal(process.platform, "win32", "ACL_PROBE_WINDOWS_REQUIRED");
  assert.equal(process.version, "v24.14.1", "ACL_PROBE_FIXED_NODE_REQUIRED");
  const { values } = parseArgs({ options: { output: { type: "string" } } });
  const temp = process.env.RUNNER_TEMP;
  assert(
    isAbsolute(temp ?? "") && isAbsolute(values.output ?? ""),
    "ACL_PROBE_OWN_OUTPUT_REQUIRED",
  );
  const suffix = relative(resolve(temp), resolve(values.output));
  assert(
    suffix && !suffix.startsWith("..") && !isAbsolute(suffix),
    "ACL_PROBE_OWN_OUTPUT_REQUIRED",
  );
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
  ])
    delete process.env[key];
  const root = await mkdtemp(join(temp, "gea-native-acl-probe-"));
  const owner = join(root, "owner");
  const cases = [];
  async function verifyCase(name, path, expectedCode) {
    diagnosticPhase = name;
    const started = performance.now();
    let facts;
    try {
      await assertPrivate(path);
      facts = calls.at(-1);
      assert.equal(facts?.phase, name, "ACL_CASE_ACTUAL_CALL_REQUIRED");
    } catch (error) {
      facts = subprocessFacts(error, performance.now() - started, error.stdout ?? "");
    }
    cases.push({ name, expectedCode, ...facts, passed: aclCasePassed(facts, expectedCode) });
  }
  let setupFailure;
  const setupStarted = performance.now();
  try {
    await secureDirectory(owner);
    await verifyCase("legal-directory", owner, 0);
    const file = join(owner, "private.json");
    await writeFile(file, "{}\n", { flag: "wx" });
    await verifyCase("legal-inherited-file", file, 0);
    const bad = join(owner, "bad");
    await secureDirectory(bad);
    diagnosticPhase = "add-owned-directory-everyone-allow";
    const addAllowCommand =
      "$ErrorActionPreference='Stop'; $path=$env:R9_PRIVATE_PATH; $acl=[IO.Directory]::GetAccessControl($path); $sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)); [IO.Directory]::SetAccessControl($path,$acl)";
    await execute(
      join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", addAllowCommand],
      { env: { ...process.env, R9_PRIVATE_PATH: bad }, windowsHide: true, timeout: 10000 },
    );
    await verifyCase("forbidden-explicit-directory", bad, 3);
    const badFile = join(bad, "inherited.json");
    await writeFile(badFile, "{}\n", { flag: "wx" });
    await verifyCase("forbidden-inherited-file", badFile, 3);
    await verifyCase("missing-path", join(owner, "missing"), 1);
  } catch (error) {
    setupFailure = {
      phase: diagnosticPhase,
      ...subprocessFacts(error, performance.now() - setupStarted, error.stdout ?? ""),
    };
  }
  const commandAvailabilityCommand =
    "$ErrorActionPreference='Stop'; foreach($name in @('Get-NetTCPConnection','Get-CimInstance','Where-Object','Select-Object','ConvertTo-Json')){try{ $null=Get-Command -Name $name -ErrorAction Stop; [Console]::Out.WriteLine($name+'=True') }catch{ [Console]::Out.WriteLine($name+'=False') }}";
  let existingNativeCommands = readCommandAvailability("");
  let commandResolutionFailure;
  const resolutionStarted = performance.now();
  diagnosticPhase = "readonly-command-resolution";
  try {
    const result = await execute(
      join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", commandAvailabilityCommand],
      { windowsHide: true, timeout: 10000 },
    );
    existingNativeCommands = readCommandAvailability(result.stdout);
  } catch (error) {
    commandResolutionFailure = subprocessFacts(
      error,
      performance.now() - resolutionStarted,
      error.stdout ?? "",
    );
  }
  const aclCasesPassed =
    !setupFailure && cases.length === 5 && cases.every((entry) => entry.passed);
  const existingNativeCommandsAvailable = Object.values(existingNativeCommands).every(
    (value) => value === true,
  );
  const passed = aclCasesPassed && existingNativeCommandsAvailable;
  const receipt = {
    schemaVersion: 2,
    status: passed
      ? "canonical-private-guard-and-native-commands-passed"
      : "canonical-private-guard-or-native-commands-failed",
    actualNativeAcceptance: false,
    cases,
    existingNativeCommands,
    existingNativeCommandsAvailable,
    commandResolutionFailure,
    aclCasesPassed,
    setupFailure,
    calls,
    sourceBindings,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    imageVersion: /^[\d.]{1,40}$/.test(process.env.ImageVersion ?? "")
      ? process.env.ImageVersion
      : "unknown",
    fixedVerifierTimeoutMs: 10000,
    psModulePathChanged: false,
  };
  await writeFile(values.output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(receipt));
  if (!passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.log(
      JSON.stringify({ status: "acl-probe-precondition-failed", actualNativeAcceptance: false }),
    );
    process.exitCode = 1;
  });
}
