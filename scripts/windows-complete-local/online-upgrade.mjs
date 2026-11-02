import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, openSync, closeSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "win32");
const [baseline, output] = process.argv.slice(2).map((path) => resolve(path));
const gea = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const oldVersion = "0.2.0-rc.2.20261030.2";
const newVersion = "0.2.0-rc.2.20261102.3";
const expectedNewSha = "2d030084d92bf115aa4850d7b80b968174dffc6a1b6a3ceb846f988bc64444e0";
const feed =
  "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/electron/win-x64/nightly.yml";
const installation = join(output, "installed");
const executable = join(installation, "GEA Desktop.exe");
const journal = join(output, "journal");
const marker = join(process.env.APPDATA, "dsh-gea-desktop", "online-upgrade-preservation.json");
const markerBytes = '{"existingUserFile":"preserve-through-live-update"}\n';
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(name),
  ),
);
environment.DSH_DESKTOP_UPDATE_JOURNAL_DIR = journal;
const evidence = {
  status: "running",
  from: oldVersion,
  to: newVersion,
  productionFeed: feed,
  installerRebuilt: false,
  updaterReplaced: false,
  forcedStopBeforeHandoff: false,
  employeeDeviceAcceptance: false,
  realBusinessSessionAcceptance: false,
  milestones: [],
};
let cdp;
let child;
await mkdir(output, { recursive: true });
function milestone(name, details = {}) {
  evidence.milestones.push({
    name,
    time: new Date().toISOString(),
    ...details,
  });
  console.log("Windows online upgrade: " + name);
}
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function powershell(script, args = [], timeout = 30000) {
  const path = join(output, "probe.ps1");
  return writeFile(path, "$ErrorActionPreference='Stop'\n& {\n" + script + "\n} @args").then(() => {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, ...args],
      {
        encoding: "utf8",
        timeout,
        env: environment,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.equal(result.status, 0, String(result.stderr || result.error || result.stdout));
    return result.stdout.trim();
  });
}
async function processes() {
  return JSON.parse(
    await powershell(
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,@{Name='IsDesktopHost';Expression={$_.CommandLine -match 'dsh-desktop-host[\\\\/]lib[\\\\/]index.js'}},@{Name='IsUpdatedClient';Expression={$_.CommandLine -match '(?:^|\\s)--updated(?:\\s|$)'}} | ConvertTo-Json -Compress",
    ),
  );
}
async function records() {
  const result = [];
  for (const name of await readdir(journal).catch(() => [])) {
    const contents = await readFile(join(journal, name), "utf8");
    for (const line of contents.trim().split("\n").filter(Boolean)) result.push(JSON.parse(line));
  }
  return result.sort((a, b) => a.time.localeCompare(b.time) || a.sequence - b.sequence);
}
async function until(name, run, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await run();
    if (result) return result;
    await delay(500);
  }
  throw new Error("TIMEOUT: " + name);
}
async function connection(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const item of pending.values()) item.reject(new Error("CDP connection closed"));
    pending.clear();
  });
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      const id = ++serial;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}
async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
async function screenshot(client, name) {
  const result = await client.send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(output, name), Buffer.from(result.data, "base64"));
}
let port;
async function targets() {
  return fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  })
    .then((response) => response.json())
    .catch(() => []);
}
async function target(prefix) {
  return (await targets()).find((item) => item.type === "page" && item.url.startsWith(prefix));
}
try {
  assert.equal(
    await sha256(baseline),
    "6cda3843fde29110328e973ae6ef059b9842dd38040a3e018538b0cb6e5bf6c1",
  );
  const response = await fetch(feed, {
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  assert.equal(response.status, 200);
  const metadata = await response.text();
  assert.equal(/^version:\s*(\S+)/m.exec(metadata)?.[1], newVersion);
  assert.ok(metadata.includes(`GEA-Desktop-${newVersion}-win-x64-signed.exe`));
  await writeFile(join(output, "live-nightly.yml"), metadata);
  milestone("published-source-and-baseline-verified");
  const trust = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(gea, "desktop/build/install-certificate.ps1"),
      "-CertificatePath",
      join(gea, "desktop/build/codesign.cer"),
      "-StoreLocation",
      "LocalMachine",
    ],
    { env: environment, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(trust.status, 0, trust.stderr);
  const install = spawn(baseline, ["/S", "/D=" + installation], {
    env: environment,
    windowsHide: true,
    stdio: "ignore",
  });
  const installed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("BASELINE_INSTALL_TIMEOUT")), 180000);
    install.once("error", reject);
    install.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(installed, 0);
  function installedVersion() {
    const result = spawnSync(
      executable,
      [
        "--expose-internals",
        "-p",
        "require(process.argv[1]).version",
        join(installation, "resources/app.asar/package.json"),
      ],
      {
        env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  assert.equal(installedVersion(), oldVersion);
  const config = await readFile(join(installation, "resources/app-update.yml"), "utf8");
  assert.ok(
    config.includes(
      "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/electron/win-x64/",
    ),
  );
  assert.ok(config.includes("publisherName:"));
  const cacheName = /^updaterCacheDirName:\s*['"]?([^'"\r\n]+)['"]?\s*$/m.exec(config)?.[1];
  assert.ok(cacheName);
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, markerBytes);
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const descriptor = openSync(join(output, "client-raw.txt"), "a");
  child = spawn(
    executable,
    [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
    { env: environment, stdio: ["ignore", descriptor, descriptor] },
  );
  closeSync(descriptor);
  const initial = await until(
    "old application window",
    async () => {
      const windows = await targets();
      return (
        windows.find((item) => item.type === "page" && item.url.includes("welcome")) ??
        ((await records()).some((row) => row.event === "workspace-ready")
          ? windows.find((item) => item.type === "page" && item.url.startsWith("dsh-app://app/"))
          : undefined)
      );
    },
    180000,
  );
  cdp = await connection(initial.webSocketDebuggerUrl);
  if (!initial.url.startsWith("dsh-app://app/")) {
    await until("company welcome button", () =>
      evaluate(cdp, "Boolean(document.getElementById('company-login'))"),
    );
    await screenshot(cdp, "01-old-welcome.png");
    await evaluate(cdp, "document.getElementById('company-login').click(); true");
    cdp.close();
    cdp = undefined;
  }
  const application = await until("old workspace renderer", () => target("dsh-app://app/"), 180000);
  cdp = await connection(application.webSocketDebuggerUrl);
  await until(
    "old Host ready",
    async () =>
      (await records()).some(
        (row) => row.version === oldVersion && row.event === "workspace-ready",
      ),
    180000,
  );
  await until("real product update bridge", () =>
    evaluate(cdp, "Boolean(window.dshDesktop?.updates?.open)"),
  );
  await screenshot(cdp, "02-old-workspace.png");
  const before = await processes();
  const owned = new Set([child.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of before)
      if (owned.has(item.ParentProcessId) && !owned.has(item.ProcessId)) {
        owned.add(item.ProcessId);
        changed = true;
      }
  }
  const oldProcesses = before.filter((item) => owned.has(item.ProcessId));
  assert.ok(
    oldProcesses.some((item) => item.IsDesktopHost),
    "The actual old Host must be running",
  );
  await writeFile(join(output, "old-processes.json"), JSON.stringify(oldProcesses, null, 2));
  milestone("old-client-and-host-running", {
    mainPid: child.pid,
    ownedProcesses: oldProcesses.length,
  });
  await evaluate(cdp, "window.dshDesktop.updates.open().catch(() => {}); true");
  milestone("product-update-action-invoked");
  let confirmation;
  await until(
    "real install-and-restart confirmation",
    async () => {
      const rows = await records();
      const failure = rows.find((row) => row.event === "state" && row.phase === "error");
      assert.equal(failure, undefined, "Real updater failed: " + JSON.stringify(failure));
      const dialog = await target("dsh-app://shell/update-dialog.html");
      if (!dialog) return false;
      const client = await connection(dialog.webSocketDebuggerUrl);
      try {
        const view = await evaluate(client, "window.dshUpdateDialog.status()");
        if (!view) return false;
        if (
          /download|下载/i.test(view.buttons[0]) &&
          !rows.some((row) => row.phase === "downloading")
        ) {
          await evaluate(client, "document.querySelector('#actions button').click(); true");
          return false;
        }
        if (!rows.some((row) => row.phase === "ready" && row.targetVersion === newVersion))
          return false;
        assert.match(view.buttons[0], /restart|重启|重新启动/i);
        await screenshot(client, "03-install-and-restart.png");
        confirmation = dialog;
        return true;
      } finally {
        client.close();
      }
    },
    300000,
  );
  assert.ok(
    (await processes()).some((item) => item.ProcessId === child.pid),
    "Old application exited before restart confirmation",
  );
  const pending = join(process.env.LOCALAPPDATA, cacheName, "pending");
  const candidates = await readdir(pending);
  for (const name of candidates.filter((name) => name.endsWith(".exe"))) {
    const actual = await sha256(join(pending, name));
    if (actual === expectedNewSha) evidence.downloadedInstallerSha256 = actual;
  }
  assert.equal(evidence.downloadedInstallerSha256, expectedNewSha);
  milestone("signed-online-download-ready-and-old-client-still-running");
  const dialog = await connection(confirmation.webSocketDebuggerUrl);
  await evaluate(
    dialog,
    "setTimeout(() => document.querySelector('#actions button').click(), 500); true",
  );
  dialog.close();
  cdp.close();
  cdp = undefined;
  const handoff = Date.now();
  await until(
    "actual installer handoff",
    async () =>
      (await records()).some(
        (row) => row.event === "install-confirmed" && row.version === oldVersion,
      ),
    60000,
  );
  await until(
    "all pre-update application and Host processes exit",
    async () => {
      const alive = await processes();
      return oldProcesses.every(
        (old) =>
          !alive.some(
            (item) => item.ProcessId === old.ProcessId && item.CreationDate === old.CreationDate,
          ),
      );
    },
    60000,
  );
  milestone("old-client-and-owned-processes-exited", {
    elapsedMs: Date.now() - handoff,
  });
  const relaunched = await until(
    "new installed application starts",
    async () =>
      (await processes()).find(
        (item) => item.ExecutablePath === executable && item.IsUpdatedClient,
      ),
    180000,
  );
  assert.equal(installedVersion(), newVersion);
  evidence.relaunchedProcess = relaunched;
  const newHost = await until(
    "new Host process",
    async () =>
      (await processes()).find(
        (item) => item.ParentProcessId === relaunched.ProcessId && item.IsDesktopHost,
      ),
    180000,
  );
  const ports = await until(
    "new Host listening server",
    async () => {
      const result = JSON.parse(
        await powershell(
          `param([int]$HostPid)
ConvertTo-Json -InputObject @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.OwningProcess -eq $HostPid} | Select-Object -ExpandProperty LocalPort) -Compress`,
          [String(newHost.ProcessId)],
        ),
      );
      const values = Array.isArray(result) ? result : result === null ? [] : [result];
      for (const port of values) {
        const response = await fetch("http://127.0.0.1:" + port + "/", {
          signal: AbortSignal.timeout(5000),
        }).catch(() => undefined);
        if (response && [200, 401, 403].includes(response.status))
          return { port, status: response.status };
      }
      return false;
    },
    180000,
  );
  const window = await until(
    "new application window",
    async () => {
      const result = JSON.parse(
        await powershell(
          `param([int]$ClientPid)
$process=Get-Process -Id $ClientPid
@{pid=$process.Id;windowHandle=$process.MainWindowHandle.ToInt64();windowTitle=$process.MainWindowTitle} | ConvertTo-Json -Compress`,
          [String(relaunched.ProcessId)],
        ),
      );
      return result.windowHandle !== 0 ? result : false;
    },
    30000,
  );
  evidence.newHost = newHost;
  evidence.newHostServer = ports;
  evidence.newWindow = window;
  assert.equal(await readFile(marker, "utf8"), markerBytes);
  const signature = JSON.parse(
    await powershell(
      `param([string]$Executable,[string]$Certificate)
$signature=Get-AuthenticodeSignature -LiteralPath $Executable
$expected=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Certificate)
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $expected.Thumbprint){throw 'INSTALLED_SIGNATURE_INVALID'}
@{status=[string]$signature.Status;thumbprint=$signature.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress`,
      [executable, join(gea, "desktop/build/codesign.cer")],
    ),
  );
  milestone("new-client-and-host-ready-with-user-file-preserved");
  Object.assign(evidence, {
    status: "passed",
    installedVersion: newVersion,
    signature,
    oldProcessesExited: true,
    newWorkspaceReady: true,
    existingUserFilePreserved: true,
    elapsedRestartMs: Date.now() - handoff,
  });
} catch (error) {
  evidence.status = "failed";
  evidence.failure = String(error.stack ?? error);
  if (cdp) await screenshot(cdp, "failure.png").catch(() => {});
  throw error;
} finally {
  cdp?.close();
  evidence.journal = await records();
  evidence.finalProcesses = (await processes().catch(() => [])).filter(
    (item) => item.ExecutablePath === executable || item.IsUpdatedClient,
  );
  const raw = await readFile(join(output, "client-raw.txt"), "utf8").catch(() => "");
  await writeFile(
    join(output, "client.log"),
    raw
      .replace(/([?&]token=)[^&\s"'<>]+/gi, "$1<REDACTED>")
      .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1<REDACTED>"),
  );
  await writeFile(join(output, "online-upgrade.json"), JSON.stringify(evidence, null, 2));
  await powershell(
    `param([string]$Executable)
Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $Executable} | ForEach-Object { & taskkill /PID $_.ProcessId /T /F | Out-Null }`,
    [executable],
  ).catch(() => {});
}
