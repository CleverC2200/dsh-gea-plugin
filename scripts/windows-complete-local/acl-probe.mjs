import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, stat, writeFile, readFile, chmod } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";
import { promisify, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
const originalExecute = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
let diagnosticPhase = "initializing";
const probeStarted = performance.now();
const calls = [];
export const sourceBindings = {
  baseEnvironmentSha256: "1f8ead4bed988a37097b300725f11a1b8d00eb9bfe1c2da24bd12a10852fced8",
  serviceListenerSha256: "d8a59d743bafc683e905b5d8f89b556ecf0028d18832a018d344fe789b0bf259",
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
export const baseEnvironment = (state) => {
  const selected = Object.fromEntries(
    ["SystemRoot", "ComSpec", "PATHEXT", "PATH", "ProgramFiles", "ProgramFiles(x86)", "WINDIR"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  return {
    ...selected,
    HOME: state.osHome,
    ZDOTDIR: state.osHome,
    CFFIXED_USER_HOME: state.osHome,
    USERPROFILE: state.osHome,
    APPDATA: state.appData,
    LOCALAPPDATA: state.appData,
    TEMP: state.temp,
    TMP: state.temp,
    TMPDIR: state.temp + "/",
    DSH_HOME: state.home,
    DSH_AGENTS_HOME: join(state.home, "agents"),
    DSH_TELEMETRY_DISABLED: "1",
    npm_config_userconfig: join(state.runRoot, "empty.npmrc"),
    npm_config_globalconfig: join(state.runRoot, "empty.npmrc"),
    npm_config_registry: "https://registry.npmjs.org",
  };
};
function validPort(port) {
  assert(
    Number.isSafeInteger(port) && port > 1024 && port <= 65535 && port !== 19387,
    "OWN_SERVICE_PORT_REQUIRED",
  );
}
export async function verifyServiceListener(origin, servicePort, appPid) {
  validPort(servicePort);
  assert.equal(origin, `http://127.0.0.1:${servicePort}`, "ACTUAL_HOST_PORT_MISMATCH");
  assert(Number.isSafeInteger(appPid) && appPid > 1, "OWN_APP_PID_REQUIRED");
  let listenerPids, parentOf;
  if (process.platform === "darwin") {
    const result = await execute("/usr/sbin/lsof", [
      "-nP",
      `-iTCP:${servicePort}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
    listenerPids = [
      ...new Set(
        result.stdout
          .split("\n")
          .filter((row) => /^p\d+$/.test(row))
          .map((row) => Number(row.slice(1))),
      ),
    ];
    parentOf = async (pid) =>
      Number((await execute("/bin/ps", ["-p", String(pid), "-o", "ppid="])).stdout.trim());
  } else {
    assert.equal(process.platform, "win32", "NATIVE_LISTENER_PLATFORM_REQUIRED");
    const powershell = join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const script = `$ErrorActionPreference='Stop'; $owners=@(Get-NetTCPConnection -State Listen -LocalPort ${servicePort} | Select-Object -ExpandProperty OwningProcess -Unique); $rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); @{owners=$owners;processes=$rows}|ConvertTo-Json -Depth 4 -Compress`;
    const result = JSON.parse(
      (
        await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
          windowsHide: true,
        })
      ).stdout,
    );
    listenerPids = result.owners;
    const parents = new Map(result.processes.map((row) => [row.ProcessId, row.ParentProcessId]));
    parentOf = async (pid) => parents.get(pid);
  }
  assert(
    Array.isArray(listenerPids) && listenerPids.length > 0,
    "ACTUAL_SERVICE_LISTENER_REQUIRED",
  );
  for (const listener of listenerPids) {
    let ancestor = listener;
    for (let depth = 0; depth < 32 && ancestor > 1 && ancestor !== appPid; depth++)
      ancestor = await parentOf(ancestor);
    assert.equal(ancestor, appPid, "SERVICE_LISTENER_NOT_OWNED");
  }
  return { origin, servicePort, appPid, listenerPids, ownedAppAncestorConfirmed: true };
}

export async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
  await assertPrivate(path);
}
export async function readPrivate(path) {
  await assertPrivate(path);
  return JSON.parse(await readFile(path, "utf8"));
}

export function safeProbeError(error, elapsedMs) {
  const assertions = [
    "EXISTING_NATIVE_COMMANDS_REQUIRED",
    "PRIVATE_WINDOWS_ACL_REQUIRED",
    "PRIVATE_POSIX_MODE_REQUIRED",
    "ACTUAL_SERVICE_LISTENER_REQUIRED",
    "SERVICE_LISTENER_NOT_OWNED",
    "ACTUAL_HOST_PORT_MISMATCH",
    "OWN_APP_PID_REQUIRED",
    "OWN_SERVICE_PORT_REQUIRED",
    "CHILD_PRIVATE_JSON_ROUNDTRIP_REQUIRED",
    "CHILD_LISTENER_START_REQUIRED",
    "CHILD_LISTENER_NORMAL_EXIT_REQUIRED",
    "CHILD_OWNED_LISTENER_REQUIRED",
    "CHILD_INPUT_REQUIRED",
    "CHILD_ENVIRONMENT_REQUIRED",
  ];
  return {
    ...subprocessFacts(error, elapsedMs),
    errorName: [
      "Error",
      "AssertionError",
      "TypeError",
      "RangeError",
      "SyntaxError",
      "ReferenceError",
      "URIError",
    ].includes(error?.name)
      ? error.name
      : "Error",
    assertion:
      assertions.find(
        (value) => error?.message === value || error?.message?.startsWith(value + "\n"),
      ) ?? "unclassified",
  };
}
const commandAvailabilityCommand =
  "$ErrorActionPreference='Stop'; foreach($name in @('Get-NetTCPConnection','Get-CimInstance','Where-Object','Select-Object','ConvertTo-Json')){try{ $null=Get-Command -Name $name -ErrorAction Stop; [Console]::Out.WriteLine($name+'=True') }catch{ [Console]::Out.WriteLine($name+'=False') }}";
async function childMain() {
  assert.equal(process.platform, "win32", "ACL_PROBE_WINDOWS_REQUIRED");
  assert.equal(process.version, "v24.14.1", "ACL_PROBE_FIXED_NODE_REQUIRED");
  const inputPath = process.argv[3];
  assert(isAbsolute(inputPath ?? ""), "CHILD_INPUT_REQUIRED");
  const state = JSON.parse(await readFile(inputPath, "utf8"));
  assert.equal(dirname(inputPath), state.runRoot, "CHILD_INPUT_REQUIRED");
  for (const key of ["home", "osHome", "appData", "temp"]) {
    const suffix = relative(state.runRoot, state[key]);
    assert(suffix && !suffix.startsWith("..") && !isAbsolute(suffix), "CHILD_INPUT_REQUIRED");
  }
  assert.equal(process.env.USERPROFILE, state.osHome, "CHILD_ENVIRONMENT_REQUIRED");
  assert.equal(process.env.TEMP, state.temp, "CHILD_ENVIRONMENT_REQUIRED");
  const report = {
    environment: "native-baseEnvironment-child",
    node: process.version,
    platform: process.platform,
    status: "failed",
    actualNativeAcceptance: false,
    cases: [],
    existingNativeCommands: readCommandAvailability(""),
    listenerOwned: false,
    cleanupConfirmed: false,
  };
  let stage = "private-directory",
    listenerProcess,
    listenerExit;
  const started = performance.now();
  try {
    diagnosticPhase = "child-private-directory";
    await assertPrivate(state.runRoot);
    report.cases.push({ name: stage, passed: true });
    stage = "private-file";
    diagnosticPhase = "child-private-file";
    await assertPrivate(inputPath);
    report.cases.push({ name: stage, passed: true });
    stage = "private-json-roundtrip";
    diagnosticPhase = "child-private-json-roundtrip";
    const path = join(state.runRoot, "roundtrip.private.json");
    await privateJson(path, { probe: true });
    assert.deepEqual(
      await readPrivate(path),
      { probe: true },
      "CHILD_PRIVATE_JSON_ROUNDTRIP_REQUIRED",
    );
    report.cases.push({ name: stage, passed: true });
    stage = "command-resolution";
    diagnosticPhase = "child-command-resolution";
    const resolution = await execute(
      join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", commandAvailabilityCommand],
      { windowsHide: true, timeout: 10000 },
    );
    report.existingNativeCommands = readCommandAvailability(resolution.stdout);
    assert(
      Object.values(report.existingNativeCommands).every((value) => value === true),
      "EXISTING_NATIVE_COMMANDS_REQUIRED",
    );
    report.cases.push({ name: stage, passed: true });
    stage = "owned-listener-start";
    const code =
      'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>process.send({port:s.address().port}));const close=()=>s.close(()=>process.exit(0));process.on("message",value=>{if(value==="close")close()});process.on("disconnect",close);';
    listenerProcess = spawn(process.execPath, ["-e", code], {
      cwd: state.runRoot,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    listenerExit = new Promise((resolve, reject) => {
      listenerProcess.once("error", reject);
      listenerProcess.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let timer;
    const servicePort = await Promise.race([
      new Promise((resolve, reject) => {
        listenerProcess.once("message", (value) => resolve(value?.port));
        listenerProcess.once("error", reject);
        listenerProcess.once("exit", () => reject(Error("CHILD_LISTENER_START_REQUIRED")));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("CHILD_LISTENER_START_REQUIRED")), 10000);
      }),
    ]).finally(() => clearTimeout(timer));
    validPort(servicePort);
    report.cases.push({ name: stage, passed: true });
    stage = "owned-service-listener";
    diagnosticPhase = "child-owned-service-listener";
    const transport = await verifyServiceListener(
      `http://127.0.0.1:${servicePort}`,
      servicePort,
      process.pid,
    );
    assert(
      transport.ownedAppAncestorConfirmed === true &&
        transport.listenerPids.length > 0 &&
        transport.listenerPids.every((pid) => pid === listenerProcess.pid),
      "CHILD_OWNED_LISTENER_REQUIRED",
    );
    report.listenerOwned = true;
    report.cases.push({ name: stage, passed: true });
    report.status = "passed";
  } catch (error) {
    report.failure = { stage, ...safeProbeError(error, performance.now() - started) };
  } finally {
    if (listenerProcess) {
      let timer;
      try {
        if (listenerProcess.connected) listenerProcess.send("close");
        const exit = await Promise.race([
          listenerExit,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("CHILD_LISTENER_NORMAL_EXIT_REQUIRED")), 10000);
          }),
        ]);
        assert.equal(exit.code, 0, "CHILD_LISTENER_NORMAL_EXIT_REQUIRED");
        assert.equal(exit.signal, null, "CHILD_LISTENER_NORMAL_EXIT_REQUIRED");
        report.cleanupConfirmed = true;
      } catch (error) {
        report.status = "failed";
        report.cleanupFailure = safeProbeError(error, performance.now() - started);
      } finally {
        clearTimeout(timer);
      }
    } else report.cleanupConfirmed = true;
  }
  report.calls = calls;
  console.log(JSON.stringify(report));
  if (report.status !== "passed" || !report.cleanupConfirmed) process.exitCode = 1;
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
  let childEnvironment = {
    environment: "native-baseEnvironment-child",
    node: process.version,
    platform: process.platform,
    status: "not-run",
    actualNativeAcceptance: false,
  };
  let childProcessFailure;
  const childEnvironmentStarted = performance.now();
  if (aclCasesPassed) {
    const childRoot = join(owner, "child-environment");
    try {
      await secureDirectory(childRoot);
      const state = {
        runRoot: childRoot,
        home: join(childRoot, "home"),
        osHome: join(childRoot, "os-home"),
        appData: join(childRoot, "app-data"),
        temp: join(childRoot, "temp"),
      };
      for (const key of ["home", "osHome", "appData", "temp"])
        await mkdir(state[key], { mode: 0o700 });
      await writeFile(join(childRoot, "empty.npmrc"), "", { mode: 0o600 });
      const input = join(childRoot, "request.private.json");
      await privateJson(input, state);
      const environment = baseEnvironment(state);
      const started = performance.now();
      let stdout;
      try {
        stdout = (
          await originalExecute(
            process.execPath,
            [resolve(process.argv[1]), "--child-environment", input],
            { cwd: childRoot, env: environment, windowsHide: true, timeout: 120000 },
          )
        ).stdout;
      } catch (error) {
        childProcessFailure = safeProbeError(error, performance.now() - started);
        stdout = error.stdout ?? "";
      }
      childEnvironment = JSON.parse(stdout);
      assert.equal(
        childEnvironment.environment,
        "native-baseEnvironment-child",
        "CHILD_ENVIRONMENT_REQUIRED",
      );
    } catch (error) {
      childProcessFailure = safeProbeError(error, performance.now() - childEnvironmentStarted);
    }
  }
  const passed =
    aclCasesPassed &&
    existingNativeCommandsAvailable &&
    childEnvironment.status === "passed" &&
    childEnvironment.cleanupConfirmed === true &&
    !childProcessFailure;

  const receipt = {
    schemaVersion: 3,
    environment: "workflow-parent",
    status: passed
      ? "canonical-private-guard-and-child-environment-passed"
      : "canonical-private-guard-or-child-environment-failed",
    actualNativeAcceptance: false,
    cases,
    existingNativeCommands,
    existingNativeCommandsAvailable,
    childEnvironment,
    childProcessFailure,
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
  (process.argv[2] === "--child-environment" ? childMain() : main()).catch((error) => {
    console.log(
      JSON.stringify({
        status: "acl-probe-precondition-failed",
        actualNativeAcceptance: false,
        failure: safeProbeError(error, performance.now() - probeStarted),
      }),
    );
    process.exitCode = 1;
  });
}
