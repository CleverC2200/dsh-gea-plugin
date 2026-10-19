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
  privacySha256: "edfb4682f4c5f9155364be4bf7c2f0a9e2cfecaca36b912ed14ba2d32bd0ebae",
  ownerFunctionSha256: "3e6095223c0d9cbb56f5c5c0529672a33cd0f70c9b0176febdc2c3675b46f87f",
  verifierFunctionSha256: "c4ef9e2c643c58eba7b7b595703d36b40620116a75242e6e1fee42b5c4ed61ba",
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
    "$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:R9_PRIVATE_PATH; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $bad=@($acl.Access | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($me,'S-1-5-18')}); if($bad.Count){exit 3}; Write-Output 'OWNER_ONLY'";
  const result = await execute(
    join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { env: { ...process.env, R9_PRIVATE_PATH: path }, windowsHide: true, timeout: 10000 },
  );
  assert.equal(result.stdout.trim(), "OWNER_ONLY", "PRIVATE_WINDOWS_ACL_REQUIRED");
}
const classificationCommand = String.raw`
$ErrorActionPreference='Stop';
function Emit($key,$value) { [Console]::Out.WriteLine($key+'='+[string]$value) }
$stage='environment';
try {
Emit 'psVersion' ($PSVersionTable.PSVersion.ToString()); Emit 'psEdition' $PSVersionTable.PSEdition; Emit 'clrVersion' ([string]$PSVersionTable.CLRVersion);
$parts=@($env:PSModulePath -split ';'); $homeModules=[IO.Path]::Combine($PSHOME,'Modules'); $hasHome=$false;
foreach($part in $parts) { if([string]::Equals($part.TrimEnd([IO.Path]::DirectorySeparatorChar),$homeModules,[StringComparison]::OrdinalIgnoreCase)) { $hasHome=$true } }
Emit 'modulePathEntryCount' $parts.Count; Emit 'modulePathHasPsHomeModules' $hasHome;
$stage='parser';
 $tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseInput($env:R9_VERIFY_COMMAND,[ref]$tokens,[ref]$errors); Emit 'parserErrorCount' (@($errors).Count);
 $stage='get-acl-resolve'; $command=Get-Command -Name Get-Acl -ErrorAction Stop; Emit 'getAclResolvable' $true; Emit 'getAclSource' $command.Source;
 $stage='get-acl'; $acl=Get-Acl -LiteralPath $env:R9_PRIVATE_PATH; Emit 'aclRead' $true; Emit 'aclProtected' $acl.AreAccessRulesProtected;
 $stage='current-sid'; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Emit 'currentSidObserved' $true;
 $stage='owner-sid'; Emit 'ownerMatchesCurrent' ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $me);
 $stage='access-enumerate'; $rules=@($acl.Access); Emit 'aceCount' $rules.Count; $allowed=0; $current=0; $system=0; $other=0; $inherited=0;
 foreach($rule in $rules) {
  if($rule.IsInherited) { $inherited++ }
  if($rule.AccessControlType -eq 'Allow') {
   $allowed++; $stage='identity-translate'; $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;
   if($sid -eq $me) { $current++ } elseif($sid -eq 'S-1-5-18') { $system++ } else { $other++ }
  }
 }
 Emit 'allowCount' $allowed; Emit 'currentAllowCount' $current; Emit 'systemAllowCount' $system; Emit 'forbiddenAllowCount' $other; Emit 'inheritedCount' $inherited; Emit 'classificationComplete' $true;
} catch { if($stage -eq 'get-acl-resolve') { Emit 'getAclResolvable' $false }; Emit 'failureStage' $stage; Emit 'exceptionType' ($_.Exception.GetType().FullName); Emit 'category' $_.CategoryInfo.Category; Emit 'fullyQualifiedErrorId' $_.FullyQualifiedErrorId; Emit 'classificationComplete' $false }
`;
export function readClassification(text) {
  const fields = Object.fromEntries(
    text.split(/\r?\n/).flatMap((line) => {
      const index = line.indexOf("=");
      return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : [];
    }),
  );
  const value = {};
  for (const key of ["psVersion", "clrVersion"])
    value[key] = /^\d+(?:\.\d+){1,4}$/.test(fields[key] ?? "") ? fields[key] : "unknown";
  value.psEdition = ["Core", "Desktop"].includes(fields.psEdition) ? fields.psEdition : "unknown";
  value.getAclSource =
    fields.getAclSource === "Microsoft.PowerShell.Security" ? fields.getAclSource : "unknown";
  for (const key of [
    "modulePathHasPsHomeModules",
    "getAclResolvable",
    "aclRead",
    "aclProtected",
    "currentSidObserved",
    "ownerMatchesCurrent",
    "classificationComplete",
  ])
    value[key] = fields[key] === "True" ? true : fields[key] === "False" ? false : null;
  for (const key of [
    "modulePathEntryCount",
    "parserErrorCount",
    "aceCount",
    "allowCount",
    "currentAllowCount",
    "systemAllowCount",
    "forbiddenAllowCount",
    "inheritedCount",
  ])
    value[key] = /^\d{1,6}$/.test(fields[key] ?? "") ? Number(fields[key]) : null;
  value.failureStage = [
    "environment",
    "parser",
    "get-acl-resolve",
    "get-acl",
    "current-sid",
    "owner-sid",
    "access-enumerate",
    "identity-translate",
  ].includes(fields.failureStage)
    ? fields.failureStage
    : null;
  const types = [
    "System.Management.Automation.CommandNotFoundException",
    "System.Management.Automation.RuntimeException",
    "System.Management.Automation.ParseException",
    "System.Management.Automation.MethodInvocationException",
    "System.Management.Automation.CmdletInvocationException",
    "System.UnauthorizedAccessException",
    "System.Security.Principal.IdentityNotMappedException",
    "System.IO.IOException",
  ];
  value.exceptionType = types.includes(fields.exceptionType)
    ? fields.exceptionType
    : "unclassified";
  value.category = [
    "ObjectNotFound",
    "PermissionDenied",
    "ParserError",
    "InvalidOperation",
    "ResourceUnavailable",
    "NotSpecified",
    "InvalidArgument",
    "SecurityError",
  ].includes(fields.category)
    ? fields.category
    : "unclassified";
  const ids = [
    "CouldNotAutoloadMatchingModule,Microsoft.PowerShell.Commands.GetCommandCommand",
    "CouldNotAutoloadMatchingModule",
    "CommandNotFoundException",
    "Modules_ModuleNotFound,Microsoft.PowerShell.Commands.ImportModuleCommand",
    "Modules_ModuleWithVersionNotFound,Microsoft.PowerShell.Commands.ImportModuleCommand",
    "System.UnauthorizedAccessException,Microsoft.PowerShell.Commands.GetAclCommand",
    "GetAcl_AccessDenied,Microsoft.PowerShell.Commands.GetAclCommand",
    "MethodInvocationException",
    "ParserError",
  ];
  value.fullyQualifiedErrorId =
    ids.find((id) => id.toLowerCase() === (fields.fullyQualifiedErrorId ?? "").toLowerCase()) ??
    "unclassified";
  return value;
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
  let originalAssertPrivatePassed = false,
    originalFailure;
  const originalStarted = performance.now();
  try {
    await secureDirectory(owner);
    originalAssertPrivatePassed = true;
  } catch (error) {
    originalFailure = {
      phase: diagnosticPhase,
      ...subprocessFacts(error, performance.now() - originalStarted, error.stdout ?? ""),
    };
  }
  const verify = /const command\s*=\s*("(?:[^"\\]|\\.)*");/.exec(assertPrivate.toString());
  assert(verify, "ACL_PROBE_FROZEN_COMMAND_REQUIRED");
  const verifierCommand = JSON.parse(verify[1]);
  const start = performance.now();
  let classification, classificationProcess;
  try {
    const result = await originalExecute(
      join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", classificationCommand],
      {
        env: { ...process.env, R9_PRIVATE_PATH: owner, R9_VERIFY_COMMAND: verifierCommand },
        windowsHide: true,
        timeout: 10000,
      },
    );
    classification = readClassification(result.stdout);
    classificationProcess = subprocessFacts(null, performance.now() - start, result.stdout);
  } catch (error) {
    classification = readClassification(error.stdout ?? "");
    classificationProcess = subprocessFacts(error, performance.now() - start, error.stdout ?? "");
  }
  const passed =
    originalAssertPrivatePassed &&
    classification.classificationComplete === true &&
    classification.parserErrorCount === 0 &&
    classification.forbiddenAllowCount === 0;
  const receipt = {
    schemaVersion: 1,
    status: passed
      ? "original-private-guard-passed-with-classification"
      : "original-private-guard-or-classification-failed",
    actualNativeAcceptance: false,
    originalAssertPrivatePassed,
    originalFailure,
    calls,
    classification,
    classificationProcess,
    sourceBindings,
    verifierCommandSha256: hash(verifierCommand),
    classificationCommandSha256: hash(classificationCommand),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    imageVersion: /^[\d.]{1,40}$/.test(process.env.ImageVersion ?? "")
      ? process.env.ImageVersion
      : "unknown",
    fixedVerifierTimeoutMs: 10000,
    psModulePathChanged: false,
    originalGuardChanged: false,
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
