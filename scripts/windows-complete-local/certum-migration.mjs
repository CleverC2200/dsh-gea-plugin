import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createSocket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import semver from "semver";
import { prepareDesktopRelease } from "../desktop-release.mjs";
import {
  certumWindowsCertificate,
  certumWindowsUpdateUrl,
  companyWindowsCertificate,
  companyWindowsUpdateUrl,
} from "./signing.mjs";
import { windowsCompanyInput } from "../ci-windows-update.mjs";

if (process.argv[2] === "--seed-session") {
  const [app, home, cwd, id] = process.argv.slice(3);
  const load = createRequire(join(app, "dsh/node_modules/@deepseek-ai/dsh/package.json"));
  const { Context } = await import(pathToFileURL(load.resolve("@deepseek-ai/cordis")));
  const { default: Persistence } = await import(
    pathToFileURL(load.resolve("@deepseek-ai/dsh-session-persistence-jsonl"))
  );
  const { SESSION_FORMAT_VERSION } = await import(
    pathToFileURL(load.resolve("@deepseek-ai/dsh-session"))
  );
  const ctx = new Context();
  try {
    await ctx.plugin(Persistence, { root: join(home, "sessions"), compression: "zstd" });
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1000,
      cwd,
      isSeeded: false,
    });
    try {
      await handle.append([
        { type: "turn/start", seq: 0, time: 1001, data: { turn: 1 } },
        {
          type: "user/message",
          seq: 1,
          time: 1002,
          surfaceOp: "append",
          data: {
            id: "migration-message",
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: "Windows certificate migration fixture" }],
          },
        },
        { type: "turn/end", seq: 2, time: 1003, data: { turn: 1, reason: { kind: "completed" } } },
      ]);
      await handle.flush();
    } finally {
      await handle.close();
    }
  } finally {
    await ctx.fiber.dispose();
  }
  process.exit(0);
}

assert.equal(process.platform, "win32");
assert.equal(process.argv.length, 5, "CERTUM_MIGRATION_INPUT_REQUIRED");
const [bridgeDir, certumDir, output] = process.argv.slice(2).map((path) => resolve(path));
const me = fileURLToPath(import.meta.url);
const gea = resolve(dirname(me), "../..");
const result = {
  status: "failed",
  source: null,
  staging: "loopback with exact unsigned feed bytes and signed installers",
  hops: [],
};
const root = await realpath(await mkdtemp(join(tmpdir(), "g-cm-")));
const install = join(root, "app");
const home = join(root, ".dsh");
const journal = join(root, "journal");
const executable = join(install, "GEA Desktop.exe");
const resources = join(install, "resources");
const snapshot = join(root, "old-data.json");
const dataTool = join(gea, "scripts/desktop-update-data.mjs");
const ps = join(root, "probe.ps1");
const session = `session-${randomUUID()}`;
const draftKey = `dsh.conversation.${session}`;
const draft = "Existing composer draft across both certificate updates";
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(name),
  ),
);
Object.assign(environment, {
  DSH_HOME: home,
  DSH_DESKTOP_UPDATE_JOURNAL_DIR: journal,
  TEMP: root,
  TMP: root,
});
const gitTar = join(process.env.ProgramFiles, "Git", "usr", "bin");
await stat(join(gitTar, "tar.exe"));
environment.PATH = gitTar + delimiter + process.env.PATH;
environment.TAR_OPTIONS = "--force-local --quoting-style=literal";
await mkdir(output, { recursive: true });

async function powershell(source, args = [], timeout = 30000) {
  await writeFile(
    ps,
    `$ErrorActionPreference='Stop'\n$env:PSModulePath=Join-Path $PSHOME 'Modules'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n& {\n${source}\n} @args`,
  );
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps, ...args],
    { env: environment, encoding: "utf8", timeout, windowsHide: true },
  ).trim();
}
async function processRows() {
  return JSON.parse(
    await powershell(
      `param([string]$Executable)
$paths=Get-CimInstance Win32_Process
$ids=@($paths | Where-Object {$_.ExecutablePath -eq $Executable} | Select-Object -ExpandProperty ProcessId)
ConvertTo-Json -InputObject @($paths | Where-Object { $_.ProcessId -in $ids -or $_.ParentProcessId -in $ids } | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate,@{Name='updated';Expression={$_.CommandLine -match '(?:^|\\s)--updated(?:\\s|$)'}},@{Name='host';Expression={$_.CommandLine -match 'dsh-desktop-host[\\\\/]lib[\\\\/]index.js'}}) -Compress`,
      [executable],
    ),
  );
}
async function records() {
  const entries = await readdir(journal).catch(() => []);
  return (
    await Promise.all(
      entries.map(async (name) =>
        (await readFile(join(journal, name), "utf8")).split("\n").filter(Boolean).map(JSON.parse),
      ),
    )
  ).flat();
}
async function until(label, read, timeout = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await read();
    if (value) return value;
    await sleep(500);
  }
  throw Error(`CERTUM_MIGRATION_TIMEOUT ${label}`);
}
async function digest(path, algorithm = "sha256", encoding = "hex") {
  const hash = createHash(algorithm);
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest(encoding);
}
async function signature(path, certificate) {
  const thumbprint = new X509Certificate(await readFile(certificate)).fingerprint.replaceAll(
    ":",
    "",
  );
  const actual = await powershell(
    `param([string]$File,[string]$Thumbprint)
$s=Get-AuthenticodeSignature -LiteralPath $File
if($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne $Thumbprint -or !$s.TimeStamperCertificate){throw 'CERTUM_MIGRATION_INVALID_SIGNATURE'}
$s.SignerCertificate.Thumbprint`,
    [path, thumbprint],
  );
  assert.equal(actual, thumbprint);
  return actual;
}
function bundled(args) {
  return execFileSync(executable, ["--expose-internals", ...args], {
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 50000,
    windowsHide: true,
  });
}
function readVersion() {
  return bundled([
    "-p",
    "require(process.argv[1]).version",
    join(resources, "app.asar/package.json"),
  ]).trim();
}
async function endApplication() {
  await powershell(
    `param([string]$Executable)
Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $Executable} | ForEach-Object {& taskkill.exe /PID $_.ProcessId /T /F | Out-Null}`,
    [executable],
  );
  await until("isolated application stopped", async () => !(await processRows()).length, 30000);
}
async function freePort() {
  const socket = createSocket();
  await new Promise((ready, reject) => socket.once("error", reject).listen(0, "127.0.0.1", ready));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}
async function evaluate(page, expression) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    return await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(Error("CERTUM_MIGRATION_CDP_TIMEOUT")), 12000);
      ws.addEventListener(
        "open",
        () =>
          ws.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: { expression, returnByValue: true, awaitPromise: true },
            }),
          ),
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(Error("CERTUM_MIGRATION_CDP_ERROR"));
        },
        { once: true },
      );
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result.exceptionDetails)
          reject(Error("CERTUM_MIGRATION_RENDERER_EVALUATION_FAILED"));
        else done(message.result.result.value);
      });
    });
  } finally {
    ws.close();
  }
}
async function target(port, prefix) {
  const all = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  })
    .then((r) => r.json())
    .catch(() => []);
  return all.find((entry) => entry.type === "page" && entry.url.startsWith(prefix));
}
async function openWorkspace() {
  const port = await freePort();
  const child = spawn(
    executable,
    [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
    { env: environment, stdio: "ignore" },
  );
  await until(
    "workspace or welcome available",
    async () => {
      if (child.exitCode !== null) throw Error(`CERTUM_MIGRATION_DESKTOP_EXIT_${child.exitCode}`);
      const welcome = await target(port, "file:");
      if (welcome?.url.includes("welcome"))
        await evaluate(welcome, `document.getElementById('company-login')?.click()`).catch(
          () => {},
        );
      const branded = await target(port, "dsh-app://shell/welcome");
      if (branded)
        await evaluate(branded, `document.getElementById('company-login')?.click()`).catch(
          () => {},
        );
      return target(port, "dsh-app://app/");
    },
    180000,
  );
  const page = await until("app renderer ready", () => target(port, "dsh-app://app/"));
  await until("official updater entry", () =>
    evaluate(page, "Boolean(window.dshDesktop?.updates?.open)").catch(() => false),
  );
  await until("started real desktop host", async () =>
    (await processRows()).some((row) => row.host && row.ParentProcessId === child.pid),
  );
  return { port, page };
}
async function loadArtifact(directory, wantsBridge) {
  const metadataPath = join(directory, "gea-local/result.json");
  const build = JSON.parse(await readFile(metadataPath, "utf8"));
  if (result.source === null) result.source = build.geaSha;
  assert.equal(build.geaSha, result.source);
  execFileSync("git", ["merge-base", "--is-ancestor", build.geaSha, "HEAD"], {
    cwd: gea,
    stdio: "ignore",
  });
  const artifacts = join(directory, "artifacts");
  const plan = await prepareDesktopRelease(artifacts, build.geaSha, metadataPath);
  assert.equal(Boolean(plan.bridge), wantsBridge);
  assert.equal(
    plan.prefix,
    wantsBridge ? "client-release/electron/win-x64/" : "client-release/electron/win-x64-certum/",
  );
  const certificate = wantsBridge ? companyWindowsCertificate : certumWindowsCertificate;
  const installer = join(artifacts, build.artifact);
  const thumbprint = await signature(installer, certificate);
  return { plan, build, certificate, thumbprint };
}
const serve = new Map();
const requests = [];
const server = createServer(async (request, response) => {
  try {
    const key = new URL(request.url, "http://localhost").pathname;
    const path = serve.get(key);
    if (!path) {
      response.writeHead(404).end();
      return;
    }
    const { size } = await stat(path);
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (request.headers.range && !match) {
      response.writeHead(416).end();
      return;
    }
    const start = match ? Number(match[1]) : 0;
    const end = match ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || end >= size) {
      response.writeHead(416).end();
      return;
    }
    requests.push(key);
    response.writeHead(match ? 206 : 200, {
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      "Cache-Control": "no-store",
    });
    if (request.method === "HEAD") response.end();
    else await pipeline(createReadStream(path, { start, end }), response);
  } catch {
    response.destroy();
  }
});

async function bindFeed(expectedUrl, stagedUrl) {
  const path = join(resources, "app-update.yml");
  const previous = await readFile(path, "utf8");
  const configured = parse(previous);
  assert.equal(configured.url, expectedUrl);
  assert.equal(configured.provider, "generic");
  assert.equal(configured.channel, "nightly");
  const publisher =
    expectedUrl === companyWindowsUpdateUrl ? "思念食品数智化部" : "思念食品有限公司";
  assert.ok(
    (Array.isArray(configured.publisherName)
      ? configured.publisherName
      : [configured.publisherName]
    ).some((entry) => entry.includes(`CN=${publisher}`)),
  );
  const staged = previous.replace(expectedUrl, stagedUrl);
  assert.equal(parse(staged).url, stagedUrl);
  assert.deepEqual(parse(staged).publisherName, configured.publisherName);
  await writeFile(path, staged);
  return path;
}

async function upgrade(fromVersion, fromUrl, stagedUrl, targetBuild, previousWorkspace) {
  const toVersion = targetBuild.plan.version;
  const config = await bindFeed(fromUrl, stagedUrl);
  const workspace = await openWorkspace();
  if (previousWorkspace) await previousWorkspace(workspace);
  console.log(`Windows native updater: ${fromVersion} → ${toVersion}, profile ready`);
  const oldRows = await processRows();
  const oldEvents = new Set((await records()).map((row) => JSON.stringify(row)));
  const events = async () => (await records()).filter((row) => !oldEvents.has(JSON.stringify(row)));
  const oldHash = await digest(executable);
  await evaluate(workspace.page, "window.dshDesktop.updates.open().catch(()=>{}); true");
  const dialog = await until(
    `official installer prompt ${toVersion}`,
    async () => {
      const states = await events();
      const failed = states.find((row) => row.phase === "error" && row.version === fromVersion);
      if (failed)
        throw Error(
          `CERTUM_MIGRATION_OFFICIAL_UPDATER_ERROR ${failed.failedOperation ?? "unknown"} ${failed.errorCode ?? ""}`,
        );
      const page = await target(workspace.port, "dsh-app://shell/update-dialog.html");
      if (!page) return false;
      const state = await evaluate(page, "window.dshUpdateDialog.status()");
      const button = state?.buttons?.[0];
      if (/download|下载/i.test(button) && !states.some((row) => row.phase === "downloading"))
        await evaluate(page, "document.querySelector('#actions button').click(); true");
      return states.some((row) => row.phase === "ready" && row.targetVersion === toVersion) &&
        /restart|重启|重新启动/i.test(button)
        ? page
        : false;
    },
    300000,
  );
  await evaluate(
    dialog,
    "setTimeout(()=>document.querySelector('#actions button').click(),250); true",
  );
  console.log(`Windows native updater: ${toVersion}, install and restart selected`);
  await until(
    "old tree exited and native successor appeared",
    async () => {
      const rows = await processRows();
      if (
        oldRows.some((old) =>
          rows.some(
            (current) =>
              old.ProcessId === current.ProcessId && old.CreationDate === current.CreationDate,
          ),
        )
      )
        return false;
      return rows.find((row) => row.ExecutablePath === executable && row.updated);
    },
    180000,
  );
  assert.equal(readVersion(), toVersion);
  assert.notEqual(await digest(executable), oldHash);
  await until(
    "successor workspace ready",
    async () =>
      (await events()).some((row) => row.version === toVersion && row.event === "workspace-ready"),
    180000,
  );
  await until(
    "native process has visible application window",
    async () =>
      (await powershell(
        `param([string]$Exe)
@((Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $Exe -and $_.CommandLine -match '(?:^|\\s)--updated(?:\\s|$)'}) | ForEach-Object {(Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle.ToInt64()} | Where-Object {$_ -ne 0}).Count`,
        [executable],
      )) !== "0",
  );
  console.log(`Windows native updater: ${toVersion}, successor window ready`);
  assert.ok(
    requests.some((key) => key === new URL(targetBuild.build.artifact, stagedUrl).pathname),
  );
  const signer = await signature(executable, targetBuild.certificate);
  assert.equal(signer, targetBuild.thumbprint);
  const receiptPath = join(root, `${toVersion}-data.json`);
  bundled([dataTool, "--home", home, "--before", snapshot, "--output", receiptPath]);
  const data = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(data.status, "passed");
  assert.equal(parse(await readFile(config, "utf8")).url, certumWindowsUpdateUrl);
  const hop = {
    from: fromVersion,
    to: toVersion,
    installerSha256: targetBuild.build.sha256,
    signature: signer,
    nativeRelaunch: true,
    workspaceReady: true,
    data,
    composerDraftRetained: false,
  };
  result.hops.push(hop);
  await endApplication();
  return hop;
}

async function readDraft(workspace, hop) {
  const value = await evaluate(
    workspace.page,
    `JSON.parse(localStorage.getItem(${JSON.stringify(draftKey)})??'null')?.draft`,
  );
  assert.equal(value, draft);
  hop.composerDraftRetained = true;
}

try {
  const certInput = companyWindowsCertificate;
  await powershell(
    `param([string]$Script,[string]$Certificate)
& $Script -CertificatePath $Certificate -StoreLocation LocalMachine`,
    [join(gea, "desktop/build/install-certificate.ps1"), certInput],
  );
  const bridge = await loadArtifact(bridgeDir, true);
  const certum = await loadArtifact(certumDir, false);
  const from = windowsCompanyInput.desktopVersion;
  assert.ok(
    semver.lt(from, bridge.plan.version) && semver.lt(bridge.plan.version, certum.plan.version),
  );
  for (const [route, artifact] of [
    ["legacy", bridge],
    ["certum", certum],
  ])
    for (const file of artifact.plan.files) serve.set(`/${route}/${file.name}`, file.path);
  await new Promise((ready, reject) => server.once("error", reject).listen(0, "127.0.0.1", ready));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const oldInstaller = join(root, "old.exe");
  const response = await fetch(windowsCompanyInput.installerUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, 200);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(oldInstaller, { flags: "wx" }));
  assert.equal(await digest(oldInstaller), windowsCompanyInput.installerSha256);
  await signature(oldInstaller, companyWindowsCertificate);
  const installed = spawnSync(oldInstaller, ["/S", `/D=${install}`], {
    env: environment,
    timeout: 180000,
    windowsHide: true,
  });
  assert.equal(installed.status, 0);
  await endApplication();
  assert.equal(readVersion(), from);
  const first = await upgrade(
    from,
    companyWindowsUpdateUrl,
    url + "legacy/",
    bridge,
    async (workspace) => {
      bundled([me, "--seed-session", join(resources, "app.asar"), home, root, session]);
      const value = JSON.stringify({ draft, view: null, viewRequest: null });
      await evaluate(
        workspace.page,
        `localStorage.setItem(${JSON.stringify(draftKey)},${JSON.stringify(value)}); true`,
      );
      const data = JSON.parse(bundled([dataTool, "--home", home, "--capture", snapshot]));
      assert.ok(data.sessions >= 1 && data.events >= 3);
    },
  );
  const second = await upgrade(
    first.to,
    certumWindowsUpdateUrl,
    url + "certum/",
    certum,
    (workspace) => readDraft(workspace, first),
  );
  await readDraft(await openWorkspace(), second);
  await endApplication();
  assert.equal(
    parse(await readFile(join(resources, "app-update.yml"), "utf8")).url,
    certumWindowsUpdateUrl,
  );
  result.status = "passed";
} catch (error) {
  result.failure = String(error.message).split("\n")[0].replaceAll(root, "<TEST_ROOT>");
  throw error;
} finally {
  server.closeAllConnections();
  server.close();
  await writeFile(join(output, "certum-migration-result.json"), JSON.stringify(result, null, 2));
  await endApplication().catch(() => {});
}
