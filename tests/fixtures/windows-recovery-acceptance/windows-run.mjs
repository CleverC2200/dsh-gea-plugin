import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, openSync, closeSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { readDraft } from "./verify-draft.mjs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
assert.equal(process.platform, "win32");
const { values } = parseArgs({
  options: {
    "build-receipt": { type: "string" },
    input: { type: "string" },
    output: { type: "string" },
    "recheck-recovery-ui": { type: "boolean" },
    "old-visible-entry": { type: "boolean" },
    "trace-legacy-host": { type: "boolean" },
    "repair-affected-baseline": { type: "boolean" },
  },
});
const buildReceipt = resolve(values["build-receipt"]);
const targetBuild = await readFile(buildReceipt);
const build = JSON.parse(targetBuild);
const fixed = JSON.parse(await readFile(values.input, "utf8"));
const output = resolve(values.output);
const privateOutput = output + "-private";
await mkdir(output);
await mkdir(privateOutput);
const gea = resolve(process.cwd(), "gea");
const { readOnlineUpgradeTarget, verifyOnlineUpgradeFeed } = await import(
  pathToFileURL(join(gea, "scripts/windows-complete-local/online-upgrade-input.mjs"))
);
const { companyWindowsCertificate } = await import(
  pathToFileURL(join(gea, "scripts/windows-complete-local/signing.mjs"))
);
const repairAffectedBaseline = values["repair-affected-baseline"];
const interruptPreparation = !repairAffectedBaseline && !values["old-visible-entry"];
const {
  version: oldVersion,
  source: oldSource,
  sha256: baselineSha,
} = repairAffectedBaseline
  ? {
      version: "0.2.0-rc.2.20261118.1",
      source: "b2c1f5faf5198e9390491773c78be8dd8302e426",
      sha256: "043ae109a1cef0b34334d988231b127abe5ec4c76d66ffd8cd5343ee48a3ee15",
    }
  : {
      version: "0.2.0-rc.2.20261123.1",
      source: "cd4234bf8563db2fe24c80079907a8251bdf7d73",
      sha256: "9b91e1151bcddec81855da93605ba4ee358a1c22243bda2201c962cdf2ee0006",
    };
const targetInput = readOnlineUpgradeTarget(build, {
  sourceSha: process.env.GITHUB_SHA,
  qualifiedSourceSha: process.env.GEA_QUALIFICATION_SOURCE_SHA,
  checkout: gea,
  baselineVersion: oldVersion,
});
const { version: newVersion, sha256: expectedNewSha, feedUrl: feed } = targetInput;
assert.equal(newVersion, fixed.desktopVersion);
const baseline = join(privateOutput, "baseline.exe");
const baselineUrl = `https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/${oldSource}/desktop/Synear-GEA-${oldVersion}-win-x64-signed.exe`;
const baselineDownload = await fetch(baselineUrl, {
  redirect: "error",
  signal: AbortSignal.timeout(180000),
});
assert.equal(baselineDownload.status, 200);
await pipeline(
  Readable.fromWeb(baselineDownload.body),
  (await import("node:fs")).createWriteStream(baseline, { flags: "wx" }),
);
const home = join(homedir(), ".dsh");
const profile = join(home, "profiles/desktop");
const snapshot = join(privateOutput, "old-data.json");
const history = join(privateOutput, "history-input.json");
const sessionId = "session-6e10a0f1-c9de-4174-ae9c-b088f52fe009";
const markerDraft = "Managed upgrade saved composer draft 6e10a0f1";
const managedCore = fixed.seed.core.head;
const companyNames = new Set([
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "@cleverc2200/gea-dsh-prototype",
]);
const expectedCompany = fixed.seed.packages.filter((row) => companyNames.has(row.name));
assert.equal(expectedCompany.length, 3);
const dataTool = join(import.meta.dirname, "desktop-update-data.mjs");
const historyTool = join(import.meta.dirname, "seed-history.mjs");
let candidateServer;
const installation = join(privateOutput, "installed");
const executable = join(installation, "GEA Desktop.exe");
const journal = join(privateOutput, "journal");
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
  target: targetInput,
  buildReceiptSha256: createHash("sha256").update(targetBuild).digest("hex"),
  installerRebuilt: false,
  updaterReplaced: false,
  forcedStopBeforeHandoff: false,
  employeeDeviceAcceptance: false,
  realBusinessSessionAcceptance: false,
  milestones: [],
};
let cdp;
let child;
let offlineRule;
const legacyTrace = join(privateOutput, "legacy-host-trace.jsonl");
await mkdir(output, { recursive: true });
function milestone(name, details = {}) {
  evidence.milestones.push({
    name,
    time: new Date().toISOString(),
    ...details,
  });
  console.log("Windows online upgrade: " + name);
}
async function fileDigest(path, algorithm = "sha256", encoding = "hex") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
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
  const notifications = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method) notifications.get(message.method)?.(message.params);
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
    once(method) {
      return new Promise((resolve) =>
        notifications.set(method, (value) => {
          notifications.delete(method);
          resolve(value);
        }),
      );
    },
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
async function traceLegacyStartup(port) {
  const recipe = join(privateOutput, "legacy-host-probe.mjs");
  await writeFile(
    recipe,
    `
    import { appendFileSync } from "node:fs";
    import { Session } from "node:inspector";
    import { syncBuiltinESMExports } from "node:module";
    import { delimiter, join } from "node:path";
    import { promisify } from "node:util";
    import { t as readTar } from ${JSON.stringify(import.meta.resolve("tar"))};
    const report = (value) => appendFileSync(${JSON.stringify(legacyTrace)}, JSON.stringify({ time: new Date().toISOString(), ...value }) + "\\n");
    report({ kind: "host-probe-loaded", hasDesktopVersion: Boolean(process.env.GEA_DESKTOP_VERSION) });
    const session = new Session();
    session.connect();
    session.post("Debugger.enable");
    session.on("Debugger.paused", ({ params }) => {
      const frame = params.callFrames.find((candidate) => candidate.scopeChain.some((scope) => scope.type === "catch"));
      const scope = frame?.scopeChain.find((candidate) => candidate.type === "catch");
      if (!scope) { session.post("Debugger.resume"); return; }
      session.post("Runtime.getProperties", { objectId: scope.object.objectId, ownProperties: true }, (_, reply) => {
        const binding = reply?.result.find((property) => property.value?.subtype === "error")?.name;
        if (!binding || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)) { session.post("Debugger.resume"); return; }
        session.post("Debugger.evaluateOnCallFrame", {
          callFrameId: frame.callFrameId,
          expression: "((error) => ({name:error.name,code:error.code,status:error.status,signal:error.signal,syscall:error.syscall,timeout:/timed out|ETIMEDOUT/i.test(error.message),commandFailed:/^Command failed:/i.test(error.message),tarFlags:/^tar(?:[.]exe)? +(-[A-Za-z]+) +/.exec(error.cmd ?? error.message.slice(16))?.[1],tarRemotePath:/cannot connect to|could not resolve hostname|rmt:/i.test(String(error.stderr ?? '')),tarNameEncoding:/cannot be converted|conversion|invalid multibyte/i.test(String(error.stderr ?? '')),tarOpenError:/error opening archive|failed to open|cannot open/i.test(String(error.stderr ?? '')),tarArchiveReadError:/unrecognized archive|truncated|damaged/i.test(String(error.stderr ?? '')),stack:String(error.stack).split(String.fromCharCode(10)).slice(1,8).map((line) => line.trim().split(' ').slice(0,2).join(' ')).filter((line) => /^at [A-Za-z0-9._<>]+$/.test(line))}))(" + binding + ")",
          returnByValue: true,
        }, (_, reply) => {
          const detail = reply?.result?.value;
          if (detail) {
            report({ kind: "caught-host-error", ...detail });
            if (detail.tarFlags && detail.tarRemotePath && !process.env.TAR_OPTIONS?.includes("--force-local")) {
              process.env.TAR_OPTIONS = [process.env.TAR_OPTIONS, "--force-local"].filter(Boolean).join(" ");
              report({ kind: "controlled-host-change", tarForceLocal: true });
            } else if (detail.tarFlags && usedSystemTar && !useTarLibrary) {
              process.env.PATH = savedPath;
              if (savedTarOptions === undefined) delete process.env.TAR_OPTIONS;
              else process.env.TAR_OPTIONS = savedTarOptions;
              useTarLibrary = true;
              report({ kind: "controlled-host-change", tarViaLibrary: true });
            }
          }
          session.post("Debugger.resume");
        });
      });
    });
    const commands = process.getBuiltinModule("node:child_process");
    const exec = commands.execFileSync;
    function tarVersion() {
      try {
        return String(exec("tar", ["--version"], { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })).split(String.fromCharCode(10))[0].trim();
      } catch {
        return "unavailable";
      }
    }
    report({ kind: "tar-version", version: tarVersion() });
    const savedPath = process.env.PATH;
    const savedTarOptions = process.env.TAR_OPTIONS;
    let usedSystemTar = false;
    let useTarLibrary = false;
    const execute = commands.execFile;
    const executeAsync = promisify(execute);
    commands.execFile = function(...args) {
      return Reflect.apply(execute, this, args);
    };
    commands.execFile[promisify.custom] = async function(executable, args, options) {
      if (!useTarLibrary || executable !== "tar" || !["-tzf", "-tvzf", "-xOf"].includes(args?.[0]))
        return executeAsync(executable, args, options);
      options?.signal?.throwIfAborted();
      const [flag, file, selected] = args;
      const stdout = [];
      await readTar({
        file,
        strict: true,
        onReadEntry(entry) {
          if (flag === "-tzf") stdout.push(entry.path + String.fromCharCode(10));
          if (flag === "-tvzf") {
            const type = entry.type === "File" ? "-" : entry.type === "Directory" ? "d" : "?";
            stdout.push(type + String.fromCharCode(10));
          }
          if (flag === "-xOf" && entry.path === selected)
            entry.on("data", (chunk) => stdout.push(chunk));
        },
      });
      options?.signal?.throwIfAborted();
      report({ kind: "tar-library-read", flag });
      return { stdout: flag === "-xOf" ? Buffer.concat(stdout).toString("utf8") : stdout.join(""), stderr: "" };
    };
    commands.execFileSync = function(executable, args, options) {
      if (!Array.isArray(args) || !args.includes("--replace")) return Reflect.apply(exec, this, [executable, args, options]);
      try {
        const result = Reflect.apply(exec, this, [executable, args, { ...options, stdio: ["ignore", "ignore", "pipe"] }]);
        report({ kind: "windows-file-replace-ok" });
        return result;
      } catch (error) {
        const signal = /UPDATE_WINDOWS_JOB_UNCONFIRMED ([A-Za-z0-9_]+(?::[0-9]+)?)/.exec(String(error.stderr ?? ""))?.[1];
        report({ kind: "windows-file-replace-failed", signal, status: error.status, code: error.code });
        throw error;
      }
    };
    syncBuiltinESMExports();
    const request = Request;
    globalThis.Request = class extends request {
      constructor(input, init) {
        super(input, init);
        if (this.url === "http://desktop.internal/api/desktop/update") {
          const action = JSON.parse(init.body).action;
          if (["desktop-prepare", "plugins-status", "desktop-cancel"].includes(action)) report({ kind: "host-route-invoked", action });
        }
      }
    };
    const json = Response.json;
    Response.json = function (body, options) {
      const code = body?.error?.code;
      if (options?.status === 409 && body?.ok === false && typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)) {
        report({ kind: "host-route-rejected", code });
        if (code === "UPDATE_REQUEST_FAILED") debugger;
        if (code === "SOURCE_ARCHIVE_INVALID" && process.env.TAR_OPTIONS?.includes("--force-local") && !usedSystemTar) {
          delete process.env.TAR_OPTIONS;
          process.env.PATH = [join(process.env.SystemRoot, "System32"), process.env.PATH].join(delimiter);
          usedSystemTar = true;
          report({ kind: "controlled-host-change", systemTar: true, version: tarVersion() });
        }
      }
      return Reflect.apply(json, this, [body, options]);
    };
  `,
  );
  const inspector = await until(
    "old main startup inspector",
    async () => {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      })
        .then((response) => response.json())
        .catch(() => []);
      return list.find((target) => target.webSocketDebuggerUrl);
    },
    15000,
  );
  const main = await connection(inspector.webSocketDebuggerUrl);
  try {
    await main.send("Debugger.enable");
    const paused = main.once("Debugger.paused");
    await main.send("Runtime.runIfWaitingForDebugger");
    const { callFrames } = await Promise.race([
      paused,
      delay(10000).then(() => {
        throw Error("OLD_MAIN_STARTUP_PAUSE_MISSING");
      }),
    ]);
    const result = await main.send("Debugger.evaluateOnCallFrame", {
      callFrameId: callFrames[0].callFrameId,
      expression: `(() => {
        const child = process.getBuiltinModule("node:child_process");
        const spawn = child.spawn;
        child.spawn = function(executable, args, options) {
          if (Array.isArray(args) && args.some((argument) => argument.includes("dsh-desktop-host"))) {
            args = ["--import", ${JSON.stringify(pathToFileURL(recipe).href)}, ...args];
          }
          return Reflect.apply(spawn, this, [executable, args, options]);
        };
        process.getBuiltinModule("node:module").syncBuiltinESMExports();
        return true;
      })()`,
      returnByValue: true,
    });
    assert.equal(result.result.value, true, JSON.stringify(result.exceptionDetails));
    await main.send("Debugger.resume");
  } finally {
    main.close();
  }
}
async function loopbackPort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const reserved = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return reserved;
}
async function screenshot(client, name) {
  const result = await client.send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(privateOutput, name), Buffer.from(result.data, "base64"));
}
async function openVisibleDesktopUpdate(client, version, image) {
  const check = await evaluate(client, "window.dshDesktop.updates.check()");
  assert.equal(check.version, version);
  const findButton = `(() => {
    const card = document.querySelector(".gea-sidebar-reminder");
    const section = [...(card?.querySelectorAll("section") ?? [])].find((item) => item.innerText.includes(${JSON.stringify(version)}));
    const button = [...(section?.querySelectorAll("button") ?? [])].find((item) => /restart and update|重启更新/i.test(item.innerText));
    return button?.getBoundingClientRect().width > 0 && !button.disabled ? button : null;
  })()`;
  await until(
    "visible GEA desktop update action",
    () => evaluate(client, `Boolean(${findButton})`),
    30000,
  );
  await screenshot(client, image);
  await evaluate(client, `${findButton}.click(); true`);
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
  assert.equal(await fileDigest(baseline), baselineSha);
  const originalInstaller = resolve(dirname(buildReceipt), "../artifacts", targetInput.artifact);
  assert.equal(await fileDigest(originalInstaller), expectedNewSha);
  assert.equal(
    new X509Certificate(await readFile(companyWindowsCertificate)).fingerprint256,
    targetInput.fingerprint,
  );
  const artifacts = dirname(originalInstaller);
  const metadata = await readFile(join(artifacts, "nightly.yml"), "utf8");
  verifyOnlineUpgradeFeed(metadata, {
    ...targetInput,
    sha512: await fileDigest(originalInstaller, "sha512", "base64"),
  });
  evidence.feedSha256 = createHash("sha256").update(metadata).digest("hex");
  const requests = [];
  let recoveryFeed;
  const allowed = new Map([
    ["/nightly.yml", join(artifacts, "nightly.yml")],
    ["/" + targetInput.artifact, originalInstaller],
    ["/" + targetInput.artifact + ".blockmap", originalInstaller + ".blockmap"],
  ]);
  candidateServer = createHttpServer(async (request, response) => {
    try {
      const name = new URL(request.url, "http://127.0.0.1").pathname;
      if (name === "/nightly.yml" && recoveryFeed) {
        response
          .writeHead(200, { "Content-Type": "text/yaml", "Cache-Control": "no-store" })
          .end(recoveryFeed);
        return;
      }
      if (recoveryFeed) {
        requests.push({ name, range: Boolean(request.headers.range) });
        response.writeHead(404).end();
        return;
      }
      const path = allowed.get(name);
      if (!path) {
        response.writeHead(404).end();
        return;
      }
      const info = await (await import("node:fs/promises")).stat(path);
      requests.push({ name, range: Boolean(request.headers.range) });
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      if (request.headers.range && !range) {
        response.writeHead(416).end();
        return;
      }
      const start = range ? Number(range[1]) : 0;
      const end = range ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      response.writeHead(range ? 206 : 200, {
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
      });
      if (request.method === "HEAD") response.end();
      else await pipeline(createReadStream(path, { start, end }), response);
    } catch {
      response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    candidateServer.once("error", reject);
    candidateServer.listen(0, "127.0.0.1", resolve);
  });
  const candidateUrl = "http://127.0.0.1:" + candidateServer.address().port + "/";
  evidence.candidateSource = { transport: "isolated-loopback", fixedFeedBytes: true, requests };
  milestone("candidate-source-and-baseline-verified");
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
  const appRoot = join(installation, "resources/app.asar");
  const appBefore = await fileDigest(appRoot);
  const exeBefore = await fileDigest(executable);
  const changed = config.replace(feed.slice(0, -"nightly.yml".length), candidateUrl);
  assert.notEqual(changed, config);
  assert.ok(changed.includes("publisherName:"));
  await writeFile(join(installation, "resources/app-update.yml"), changed);
  assert.equal(await fileDigest(appRoot), appBefore);
  assert.equal(await fileDigest(executable), exeBefore);
  evidence.untouchedBaselineCode = { exeSha256: exeBefore, asarSha256: appBefore };
  environment.DSH_HOME = home;
  const runBundled = (script, args) => {
    const result = spawnSync(executable, ["--expose-internals", script, ...args], {
      env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 45000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };
  const cacheName = /^updaterCacheDirName:\s*['"]?([^'"\r\n]+)['"]?\s*$/m.exec(config)?.[1];
  assert.ok(cacheName);
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, markerBytes);
  port = await loopbackPort();
  const baselineMainPort =
    repairAffectedBaseline || values["trace-legacy-host"] ? await loopbackPort() : undefined;
  const descriptor = openSync(join(privateOutput, "client-raw.txt"), "a");
  child = spawn(
    executable,
    [
      ...(baselineMainPort
        ? [`--inspect${values["trace-legacy-host"] ? "-brk" : ""}=127.0.0.1:${baselineMainPort}`]
        : []),
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
    ],
    { env: environment, stdio: ["ignore", descriptor, descriptor] },
  );
  closeSync(descriptor);
  if (values["trace-legacy-host"]) await traceLegacyStartup(baselineMainPort);
  const initial = await until(
    "old application window",
    async () => {
      const windows = await targets();
      return (
        windows.find((item) => item.type === "page" && item.url.includes("welcome")) ??
        (repairAffectedBaseline || (await records()).some((row) => row.event === "workspace-ready")
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
      repairAffectedBaseline
        ? (await processes()).some((row) => row.ParentProcessId === child.pid && row.IsDesktopHost)
        : (await records()).some(
            (row) => row.version === oldVersion && row.event === "workspace-ready",
          ),
    180000,
  );
  if (!repairAffectedBaseline) {
    await until("real product update bridge", () =>
      evaluate(cdp, "Boolean(window.dshDesktop?.updates?.open)"),
    );
  }
  await screenshot(cdp, "02-old-workspace.png");
  await writeFile(
    history,
    JSON.stringify({ root: appRoot, home, cwd: privateOutput, sessionId, mode: "create" }),
  );
  const historyBefore = runBundled(historyTool, [history]);
  assert.equal(historyBefore.status, "history-created-and-read-back");
  const draftKey = "dsh.conversation." + sessionId;
  const draftValue = { draft: markerDraft, view: null, viewRequest: null };
  assert.equal(
    await evaluate(
      cdp,
      `(() => { localStorage.setItem(${JSON.stringify(draftKey)},${JSON.stringify(JSON.stringify(draftValue))});return JSON.parse(localStorage.getItem(${JSON.stringify(draftKey)})).draft })()`,
    ),
    markerDraft,
  );
  const oldData = runBundled(dataTool, ["--home", home, "--capture", snapshot]);
  assert.ok(oldData.sessions > 0 && oldData.events > 0);
  evidence.historyBefore = oldData;
  evidence.oldDraftSaved = true;
  const draftPath = join(process.env.APPDATA, "GEA Desktop");
  const npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const dependencies = join(privateOutput, "draft-deps");
  const installedDependency = spawnSync(
    process.execPath,
    [
      npm,
      "install",
      "--prefix",
      dependencies,
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "classic-level@2.0.0",
    ],
    {
      env: environment,
      encoding: "utf8",
      timeout: 90000,
      windowsHide: true,
    },
  );
  assert.equal(installedDependency.status, 0, "DRAFT_READER_DEPENDENCY_FAILED");
  const { ClassicLevel } = createRequire(join(dependencies, "package.json"))("classic-level");
  const lock = join(profile, "gea/installations", managedCore, "plugins/prepare.lock");
  if (interruptPreparation) {
    const abandoned = join(privateOutput, "abandoned-preparation.json");
    const workerScript = join(privateOutput, "interrupt-preparation.mjs");
    await writeFile(
      workerScript,
      `
    import { writeFile } from "node:fs/promises";
    import { pathToFileURL } from "node:url";
    const [entry, profile, coreHead, result] = process.argv.slice(2);
    const { CompanyInstallation } = await import(pathToFileURL(entry));
    const installation = new CompanyInstallation(profile, coreHead);
    await installation.prepare("interrupted-signed-upgrade", async (stage) => {
      await writeFile(result, JSON.stringify({ pid: process.pid, stage }));
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `,
    );
    const worker = spawn(
      executable,
      [
        "--expose-internals",
        workerScript,
        join(appRoot, "company-installation.mjs"),
        profile,
        managedCore,
        abandoned,
      ],
      {
        env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: "inherit",
      },
    );
    try {
      const prepared = await until(
        "real prior preparation reached the staging directory",
        async () => JSON.parse(await readFile(abandoned, "utf8").catch(() => "null")),
      );
      assert.equal(prepared.pid, worker.pid);
      assert.ok(prepared.stage.includes("staging-"));
      assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, worker.pid);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        const ended = new Promise((resolve) => worker.once("exit", resolve));
        const killed = spawnSync("taskkill.exe", ["/PID", String(worker.pid), "/T", "/F"], {
          env: environment,
          windowsHide: true,
          encoding: "utf8",
        });
        assert.equal(killed.status, 0, killed.stderr);
        await ended;
      }
    }
    assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, worker.pid);
    milestone("prior-package-preparation-interrupted-with-lock-preserved");
  }
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
  await writeFile(join(privateOutput, "old-processes.json"), JSON.stringify(oldProcesses, null, 2));
  milestone("old-client-and-host-running", {
    mainPid: child.pid,
    ownedProcesses: oldProcesses.length,
  });
  const oldCore = JSON.parse(
    await readFile(join(profile, "gea/installation.json"), "utf8"),
  ).coreHead;
  assert.equal(
    oldCore,
    repairAffectedBaseline ? "8cc49e9b5c5ddf3751af2f6fb21276513a14bf9b" : managedCore,
  );
  evidence.oldCore = oldCore;
  let handoff;
  let recoveryReceipt;
  if (repairAffectedBaseline) {
    const id = "a8a2fc6c-6dcf-4094-85da-cc6a3e8981e4";
    const directory = join(profile, "gea/plugin-updates");
    const operation = join(directory, "operations", id, "receipt.json");
    await mkdir(dirname(operation), { recursive: true });
    await writeFile(operation, JSON.stringify({ id, stage: "accepted" }), { flag: "wx" });
    await writeFile(join(directory, "latest.json"), JSON.stringify({ id }));
    recoveryReceipt = { path: operation, digest: await fileDigest(operation) };
    if (cdp) cdp.close();
    cdp = undefined;
    const debuggerTarget = await until(
      "old client main inspector",
      async () => {
        const list = await fetch(`http://127.0.0.1:${baselineMainPort}/json/list`, {
          signal: AbortSignal.timeout(2000),
        })
          .then((reply) => reply.json())
          .catch(() => []);
        return list.find((item) => item.webSocketDebuggerUrl);
      },
      15000,
    );
    const oldMain = await connection(debuggerTarget.webSocketDebuggerUrl);
    try {
      assert.equal(
        await evaluate(
          oldMain,
          `(() => {
        const path = process.getBuiltinModule("node:path");
        const load = process.getBuiltinModule("node:module").createRequire(
          path.join(process.resourcesPath, "app.asar", "package.json"));
        const { app, BrowserWindow } = load("electron");
        const workspace = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith("dsh-app://app/"));
        if (!workspace) return false;
        workspace.webContents.session.flushStorageData();
        setTimeout(() => app.quit(), 250);
        return true;
      })()`,
        ),
        true,
      );
    } finally {
      oldMain.close();
    }
    handoff = Date.now();
    evidence.firstHop = "signed-in-place-cover-of-affected-baseline";
  } else {
    if (values["old-visible-entry"]) {
      await openVisibleDesktopUpdate(cdp, newVersion, "03-old-visible-update.png");
      evidence.firstHop = "old-visible-gea-reminder";
    } else {
      await evaluate(cdp, "window.dshDesktop.updates.open().catch(() => {}); true");
      evidence.firstHop = "old-native-update-bridge";
    }
    milestone("product-update-action-invoked", { entry: evidence.firstHop });
    let confirmation;
    await until(
      "real install-and-restart confirmation",
      async () => {
        const rows = await records();
        if (
          values["old-visible-entry"] &&
          rows.some((row) => row.event === "workspace-ready" && row.version === newVersion)
        ) {
          evidence.firstHopConfirmedBySuccessor = true;
          return true;
        }
        const failure = rows.find((row) => row.event === "state" && row.phase === "error");
        assert.equal(failure, undefined, "Real updater failed: " + JSON.stringify(failure));
        const dialog = await target("dsh-app://shell/update-dialog.html");
        if (!dialog) return false;
        const client = await connection(dialog.webSocketDebuggerUrl);
        try {
          const view = await evaluate(client, "window.dshUpdateDialog.status()");
          if (!view) return false;
          if (values["old-visible-entry"])
            evidence.oldVisibleDialog = { message: view.message, buttons: view.buttons };
          if (values["trace-legacy-host"] && /did not complete|更新未完成/i.test(view.message)) {
            const trace = await readFile(legacyTrace, "utf8").catch(() => "");
            if (!evidence.oldVisibleRetriedWithForceLocal && trace.includes('"tarForceLocal":true')) {
              evidence.oldVisibleRetriedWithForceLocal = true;
              milestone("old-visible-retry-with-only-tar-force-local");
            } else if (!evidence.oldVisibleRetriedWithSystemTar && trace.includes('"systemTar":true')) {
              evidence.oldVisibleRetriedWithSystemTar = true;
              milestone("old-visible-retry-with-only-system-tar");
            } else if (!evidence.oldVisibleRetriedWithTarLibrary && trace.includes('"tarViaLibrary":true')) {
              evidence.oldVisibleRetriedWithTarLibrary = true;
              milestone("old-visible-retry-with-only-library-archive-read");
            } else {
              throw Error("OLD_VISIBLE_UPDATE_FAILED");
            }
            await evaluate(client, "document.querySelector('#actions button').click(); true");
            await openVisibleDesktopUpdate(cdp, newVersion, "03-old-visible-tar-retry.png");
            return false;
          }
          if (
            values["old-visible-entry"] &&
            view.buttons?.some((label) => /重新检查|check again/i.test(label))
          ) {
            await screenshot(client, "03-old-visible-update-blocked.png");
            throw new Error("OLD_VISIBLE_UPDATE_REQUIRES_RECOVERY");
          }
          if (
            /download|下载/i.test(view.buttons[0]) &&
            !rows.some((row) => row.phase === "downloading")
          ) {
            await evaluate(client, "document.querySelector('#actions button').click(); true");
            return false;
          }
          if (!rows.some((row) => row.phase === "ready" && row.targetVersion === newVersion))
            return false;
          if (values["old-visible-entry"] && !view.buttons?.length) return false;
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
    const pending = join(process.env.LOCALAPPDATA, cacheName, "pending");
    const candidates = await readdir(pending).catch((error) => {
      if (error.code === "ENOENT" && evidence.firstHopConfirmedBySuccessor) return [];
      throw error;
    });
    for (const name of candidates.filter((name) => name.endsWith(".exe"))) {
      const actual = await fileDigest(join(pending, name));
      if (actual === expectedNewSha) evidence.downloadedInstallerSha256 = actual;
    }
    if (confirmation) {
      assert.ok(
        (await processes()).some((item) => item.ProcessId === child.pid),
        "Old application exited before restart confirmation",
      );
      assert.equal(evidence.downloadedInstallerSha256, expectedNewSha);
      milestone("signed-online-download-ready-and-old-client-still-running");
      const dialog = await connection(confirmation.webSocketDebuggerUrl);
      await evaluate(
        dialog,
        "setTimeout(() => document.querySelector('#actions button').click(), 500); true",
      );
      dialog.close();
    } else {
      assert.ok(requests.some(({ name }) => name === "/" + targetInput.artifact));
    }
    cdp.close();
    cdp = undefined;
    handoff = Date.now();
    await until(
      "actual installer handoff",
      async () =>
        (await records()).some(
          (row) => row.event === "install-confirmed" && row.version === oldVersion,
        ),
      60000,
    );
  }
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
  if (repairAffectedBaseline) {
    evidence.oldDraftVerifiedOnDisk = await until(
      "original closed client left a saved draft on disk",
      () =>
        readDraft(
          draftPath,
          draftKey,
          markerDraft,
          join(privateOutput, "old-draft-check"),
          ClassicLevel,
        ),
      15000,
    );
    const replaced = spawnSync(originalInstaller, ["/S", "/D=" + installation], {
      encoding: "utf8",
      env: environment,
      windowsHide: true,
      timeout: 180000,
    });
    assert.equal(replaced.status, 0, String(replaced.stderr || replaced.error));
    const rule = "GEA-isolated-offline-" + process.pid;
    await powershell(
      `param([string]$Name,[string]$Executable)
New-NetFirewallRule -Name $Name -DisplayName $Name -Direction Outbound -Program $Executable -Action Block | Out-Null
if (!(Get-NetFirewallRule -Name $Name -ErrorAction Stop)) { throw 'GEA_ISOLATED_OFFLINE_RULE_MISSING' }`,
      [rule, executable],
    );
    offlineRule = rule;
    const oldStore = join(home, "desktop-company-cache", "installation", "store");
    await mkdir(oldStore, { recursive: true });
    await writeFile(join(oldStore, "existing-store-marker"), "preserve");
    port = await loopbackPort();
    child = spawn(
      executable,
      [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
      { env: environment, windowsHide: true, stdio: "ignore" },
    );
    evidence.manualSuccessorLaunch = true;
  }
  const relaunched = await until(
    "new installed application starts",
    async () =>
      (await processes()).find(
        (item) =>
          item.ExecutablePath === executable &&
          (repairAffectedBaseline ? item.ProcessId === child.pid : item.IsUpdatedClient),
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
  if (recoveryReceipt) assert.equal(await fileDigest(recoveryReceipt.path), recoveryReceipt.digest);
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
  const proofPath = join(profile, "gea/installation.json");
  const selectionPath = join(profile, "gea/installations", managedCore, "plugins/selection.json");
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
  const running = await until(
    "actual managed Host and renderer stamps confirmed",
    async () => {
      try {
        const proof = await readJson(proofPath);
        const state = await readJson(selectionPath);
        if (
          proof.coreHead !== managedCore ||
          state.verified !== proof.graphId ||
          state.active !== proof.graphId ||
          state.booting ||
          (!repairAffectedBaseline && proof.graphId === "baseline")
        )
          return false;
        return await Promise.all(
          expectedCompany.map(async (expected) => {
            const actual = await readJson(
              join(profile, "node_modules", expected.name, "package.json"),
            );
            assert.equal(actual.version, expected.version);
            return { name: actual.name, version: actual.version, hostAndClientVerified: true };
          }),
        );
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
    150000,
  );
  evidence.runtimePackages = running;
  if (offlineRule) {
    assert.equal(
      await readFile(
        join(home, "desktop-company-cache/installation/store/existing-store-marker"),
        "utf8",
      ),
      "preserve",
    );
    evidence.crossCoreStartedWithoutOutboundNetwork = true;
    milestone("cross-core-signed-install-started-offline-with-existing-store");
  }
  if (interruptPreparation) {
    await assert.rejects(readFile(lock), { code: "ENOENT" });
    evidence.interruptedExistingInstallationRecovered = true;
  }
  const after = runBundled(dataTool, [
    "--home",
    home,
    "--before",
    snapshot,
    "--output",
    join(privateOutput, "new-data.json"),
  ]);
  assert.equal(after.status, "passed");
  evidence.data = after;
  evidence.composerDraftStorageRetained = await until(
    "old logical draft through Chromium local storage",
    () =>
      readDraft(draftPath, draftKey, markerDraft, join(privateOutput, "draft-check"), ClassicLevel),
    20000,
  );
  milestone("managed-runtime-session-and-draft-storage-verified");
  evidence.nativeUpgradePassed = !repairAffectedBaseline;
  evidence.signedOverwriteRecoveredAffectedBaseline = Boolean(recoveryReceipt);
  if (values["recheck-recovery-ui"]) {
    const stop = spawnSync("taskkill.exe", ["/PID", String(relaunched.ProcessId), "/T", "/F"], {
      env: environment,
      windowsHide: true,
      encoding: "utf8",
    });
    assert.equal(stop.status, 0, stop.stderr);
    await until(
      "updated client has stopped before isolated recovery scenario",
      async () => !(await processes()).some(({ ProcessId }) => ProcessId === relaunched.ProcessId),
    );
    const latest = join(profile, "gea/plugin-updates/latest.json");
    await mkdir(dirname(latest), { recursive: true });
    await writeFile(latest, "{", { flag: "wx" });
    const nextVersion = newVersion.replace(/\.(\d+)$/, (_, build) => "." + (Number(build) + 1));
    assert.notEqual(nextVersion, newVersion);
    const unavailableInstaller = targetInput.artifact.replace(newVersion, nextVersion);
    const unavailableSha = createHash("sha512").update(unavailableInstaller).digest("base64");
    const installedSha = await fileDigest(originalInstaller, "sha512", "base64");
    recoveryFeed = metadata
      .replace(/^version:.*$/m, "version: " + nextVersion)
      .replaceAll(targetInput.artifact, unavailableInstaller)
      .replaceAll(installedSha, unavailableSha);
    const candidateConfig = await readFile(join(installation, "resources/app-update.yml"), "utf8");
    const loopbackConfig = candidateConfig.replace(
      feed.slice(0, -"nightly.yml".length),
      candidateUrl,
    );
    assert.notEqual(candidateConfig, loopbackConfig);
    await writeFile(join(installation, "resources/app-update.yml"), loopbackConfig);
    const mainPort = await loopbackPort();
    port = await loopbackPort();
    const descriptor = openSync(join(privateOutput, "client-raw.txt"), "a");
    child = spawn(
      executable,
      [
        `--inspect=127.0.0.1:${mainPort}`,
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
      ],
      { env: environment, stdio: ["ignore", descriptor, descriptor] },
    );
    closeSync(descriptor);
    const renderer = await until("recovery candidate workspace", () => target("dsh-app://app/"));
    cdp = await connection(renderer.webSocketDebuggerUrl);
    const mainInspector = await until(
      "packaged main loopback inspector",
      async () => {
        const list = await fetch(`http://127.0.0.1:${mainPort}/json/list`, {
          signal: AbortSignal.timeout(2000),
        })
          .then((reply) => reply.json())
          .catch(() => []);
        return list.find((row) => row.webSocketDebuggerUrl);
      },
      15000,
    );
    const main = await connection(mainInspector.webSocketDebuggerUrl);
    try {
      const childPrototype = (
        await main.send("Runtime.evaluate", {
          expression: 'process.getBuiltinModule("node:child_process").ChildProcess.prototype',
        })
      ).result.objectId;
      await until(
        "live desktop Host and enabled product window",
        async () => {
          const handles = await main.send("Runtime.queryObjects", {
            prototypeObjectId: childPrototype,
          });
          const result = await main.send("Runtime.callFunctionOn", {
            objectId: handles.objects.objectId,
            functionDeclaration: `function () {
            globalThis.geaRecoveryHost = this.find((child) =>
              child.connected && child.spawnargs?.some((arg) => arg.includes("dsh-desktop-host")));
            return Boolean(globalThis.geaRecoveryHost);
          }`,
            returnByValue: true,
          });
          await main.send("Runtime.releaseObject", { objectId: handles.objects.objectId });
          if (result.result.value !== true) return false;
          return evaluate(
            main,
            `(() => {
          const path = process.getBuiltinModule("node:path");
          const load = process.getBuiltinModule("node:module").createRequire(
            path.join(process.resourcesPath, "app.asar", "package.json"));
          return load("electron").BrowserWindow.getAllWindows().some((window) =>
            window.isEnabled() && window.webContents.getURL().startsWith("dsh-app://app/"));
        })()`,
          );
        },
        45000,
      );
      await until(
        "signed candidate Host update route reports the damaged journal",
        async () => {
          const recoveryHost = await evaluate(
            main,
            `new Promise((resolve) => {
        const host = globalThis.geaRecoveryHost;
        const requestId = 900000000 + (globalThis.geaRecoveryProbeSequence = (globalThis.geaRecoveryProbeSequence ?? 0) + 1);
        const timer = setTimeout(() => finish({ error: "host-status-timeout" }), 5000);
        function finish(result) {
          host.removeListener("message", receive);
          clearTimeout(timer);
          resolve(result);
        }
        function receive(message) {
          if (message.type === "update-operation" && message.requestId === requestId)
            finish(message.result);
        }
        host.on("message", receive);
        host.send({ type: "update-operation", requestId, request: { action: "plugins-status" } },
          (error) => { if (error) finish({ error: "status-send-failed" }); });
      })`,
          );
          evidence.recoveryStatusBeforeUpdate = recoveryHost;
          if (!recoveryHost?.ok) return false;
          assert.deepEqual(recoveryHost, {
            ok: true,
            value: { operationId: null, state: "failed" },
          });
          return true;
        },
        45000,
      );
      milestone("signed-host-reports-damaged-update-journal");
      assert.equal(
        await evaluate(
          main,
          `(() => {
        const path = process.getBuiltinModule("node:path");
        const load = process.getBuiltinModule("node:module").createRequire(
          path.join(process.resourcesPath, "app.asar", "package.json"));
        const { BrowserWindow } = load("electron");
        const host = globalThis.geaRecoveryHost;
        if (!host) return false;
        const product = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith("dsh-app://app/"));
        if (!product?.isEnabled()) return false;
        const send = host.send;
        const operations = new Map();
        const facts = { missedStatus: false, requests: [], replies: {} };
        const observe = (message) => {
          const operation = operations.get(message.requestId);
          if (operation) facts.replies[operation] = message.result ??
            { active: message.active, error: message.error };
        };
        host.on("message", observe);
        host.send = function (message, ...args) {
          if (message.type === "update-operation" || message.type === "update-tasks") {
            const action = message.request?.action ?? message.action;
            facts.requests.push(action);
            if (!facts.missedStatus && action === "plugins-status") {
              facts.missedStatus = true;
              queueMicrotask(() => args.at(-1)(Error("Windows acceptance: first status unavailable")));
              return false;
            }
            operations.set(message.requestId, action);
          }
          return Reflect.apply(send, this, [message, ...args]);
        };
        globalThis.geaRecoveryAcceptance = {
          read: () => ({ ...facts, enabled: product.isEnabled() }),
          restore: () => { host.send = send; host.removeListener("message", observe); },
        };
        return true;
      })()`,
        ),
        true,
      );
      const update = await evaluate(cdp, "window.dshDesktop.updates.check()");
      assert.equal(update.phase, "available");
      assert.equal(update.version, nextVersion);
      await evaluate(
        cdp,
        `(() => {
        setTimeout(async () => {
          try {
            await window.dshDesktop.updates.restartUpdate({ kind: "desktop", version: ${JSON.stringify(nextVersion)} });
            globalThis.geaRecoveryStart = "resolved";
          } catch (error) {
            globalThis.geaRecoveryStart = String(error?.message ?? error);
          }
        }, 0);
        return true;
      })()`,
      );
      const check = await until(
        "actual update status retry dialog disables the product window",
        async () => {
          const dialog = await target("dsh-app://shell/update-dialog.html");
          if (!dialog) return false;
          const client = await connection(dialog.webSocketDebuggerUrl);
          try {
            const view = await evaluate(client, "window.dshUpdateDialog.status()");
            if (!view?.buttons?.some((label) => /重新检查|check again/i.test(label))) return false;
            const before = await evaluate(main, "geaRecoveryAcceptance.read()");
            assert.equal(before.enabled, false);
            assert.equal(before.missedStatus, true);
            await screenshot(client, "04-recovery-recheck.png");
            await evaluate(client, "document.querySelector('#actions button').click(); true");
            return true;
          } finally {
            client.close();
          }
        },
        45000,
      );
      assert.equal(check, true);
      await until(
        "successful recovery makes the normal update result message dismissible",
        async () => {
          const dialog = await target("dsh-app://shell/update-dialog.html");
          if (!dialog) return false;
          const client = await connection(dialog.webSocketDebuggerUrl);
          try {
            const view = await evaluate(client, "window.dshUpdateDialog.status()");
            if (!view?.dismissible || !/更新未完成|update did not complete/i.test(view.message))
              return false;
            const state = await evaluate(main, "geaRecoveryAcceptance.read()");
            assert.deepEqual(state.replies["plugins-status"], {
              ok: true,
              value: { operationId: null, state: "failed" },
            });
            assert.deepEqual(state.replies["desktop-cancel"], { ok: true, value: {} });
            assert.deepEqual(state.replies.unlock, { active: false });
            await screenshot(client, "05-recovery-result.png");
            await evaluate(client, "document.querySelector('#actions button').click(); true");
            return true;
          } finally {
            client.close();
          }
        },
        45000,
      );
      await until(
        "product window re-enabled after acknowledging the recovered update result",
        async () => (await evaluate(main, "geaRecoveryAcceptance.read()")).enabled,
        15000,
      );
      assert.equal(await readFile(latest, "utf8"), "{");
      assert.equal(
        await evaluate(cdp, `JSON.parse(localStorage.getItem(${JSON.stringify(draftKey)})).draft`),
        markerDraft,
      );
      evidence.nativeRecoveryWindowUnlocked = true;
      milestone("actual-native-recheck-unlocked-real-window");
      const previousOperations = (await evaluate(main, "geaRecoveryAcceptance.read()")).requests;
      await openVisibleDesktopUpdate(cdp, nextVersion, "06-candidate-visible-update.png");
      await until(
        "fixed button opens the native updater without a company preparation operation",
        async () => {
          const run = (await records()).filter((row) => row.version === newVersion);
          if (
            !run.some((row) => row.event === "download-requested") ||
            !run.some(
              (row) => row.failedOperation === "download" && row.targetVersion === nextVersion,
            )
          )
            return false;
          const dialog = await target("dsh-app://shell/update-dialog.html");
          if (!dialog) return false;
          const client = await connection(dialog.webSocketDebuggerUrl);
          try {
            const view = await evaluate(client, "window.dshUpdateDialog.status()");
            if (!view?.dismissible) return false;
            assert.ok(requests.some(({ name }) => name === "/" + unavailableInstaller));
            assert.deepEqual(
              (await evaluate(main, "geaRecoveryAcceptance.read()")).requests,
              previousOperations,
            );
            await screenshot(client, "07-candidate-official-download.png");
            await evaluate(client, "document.querySelector('#actions button').click(); true");
            return true;
          } finally {
            client.close();
          }
        },
        45000,
      );
      await until(
        "failed official download leaves the signed candidate usable",
        async () => (await evaluate(main, "geaRecoveryAcceptance.read()")).enabled,
        15000,
      );
      evidence.fixedVisibleEntryIgnoresDamagedJournal = true;
      milestone("fixed-visible-button-opens-native-updater-with-damaged-journal");
    } finally {
      evidence.recoveryProbe = {
        host: await evaluate(main, "globalThis.geaRecoveryAcceptance?.read()").catch(() => null),
        start: await evaluate(cdp, "globalThis.geaRecoveryStart ?? null").catch(() => null),
        hasDialog: Boolean(await target("dsh-app://shell/update-dialog.html")),
        nativeUpdateEvents: (await records()).filter((row) => row.version === newVersion),
        simulatedDownloadRequests: requests.filter(
          ({ name }) => name === "/" + unavailableInstaller,
        ),
      };
      await evaluate(main, "globalThis.geaRecoveryAcceptance?.restore()").catch(() => {});
      main.close();
    }
  }
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
  const raw = await readFile(join(privateOutput, "client-raw.txt"), "utf8").catch(() => "");
  await writeFile(
    join(privateOutput, "client.log"),
    raw
      .replace(/([?&]token=)[^&\s"'<>]+/gi, "$1<REDACTED>")
      .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1<REDACTED>"),
  );
  await writeFile(join(privateOutput, "online-upgrade.json"), JSON.stringify(evidence, null, 2));
  const publicReceipt = {
    status: evidence.status,
    actualNativeUpdateAcceptance: evidence.nativeUpgradePassed === true,
    fromVersion: oldVersion,
    toVersion: newVersion,
    firstHop: evidence.firstHop,
    firstHopConfirmedBySuccessor: evidence.firstHopConfirmedBySuccessor,
    oldVisibleDialog: evidence.oldVisibleDialog,
    oldVisibleRetriedWithForceLocal: evidence.oldVisibleRetriedWithForceLocal,
    oldVisibleRetriedWithSystemTar: evidence.oldVisibleRetriedWithSystemTar,
    oldVisibleRetriedWithTarLibrary: evidence.oldVisibleRetriedWithTarLibrary,
    legacyHostTrace: values["trace-legacy-host"]
      ? (await readFile(legacyTrace, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
      : undefined,
    legacyNativeEvents: values["trace-legacy-host"] ? evidence.journal : undefined,
    buildReceiptSha256: evidence.buildReceiptSha256,
    inputSha256: build.inputSha256,
    installerSha256: expectedNewSha,
    feedSha256: evidence.feedSha256,
    relaunch: evidence.relaunchedProcess
      ? {
          method: repairAffectedBaseline ? "signed-installer" : "native-updater",
          nativeUpdatedFlag: !repairAffectedBaseline,
          manualSuccessorLaunch: Boolean(evidence.manualSuccessorLaunch),
        }
      : null,
    signedOverwriteRecoveredAffectedBaseline: evidence.signedOverwriteRecoveredAffectedBaseline,
    crossCoreStartedWithoutOutboundNetwork: evidence.crossCoreStartedWithoutOutboundNetwork,
    oldCore: evidence.oldCore,
    runtimePackages: evidence.runtimePackages,
    interruptedExistingInstallationRecovered: evidence.interruptedExistingInstallationRecovered,
    nativeRecoveryWindowUnlocked: evidence.nativeRecoveryWindowUnlocked,
    fixedVisibleEntryIgnoresDamagedJournal: evidence.fixedVisibleEntryIgnoresDamagedJournal,
    recoveryStatusBeforeUpdate: evidence.recoveryStatusBeforeUpdate,
    recoveryProbe: evidence.recoveryProbe,
    data: evidence.data,
    composerDraftStorageRetained: evidence.composerDraftStorageRetained,
    oldDraftVerifiedOnDisk: evidence.oldDraftVerifiedOnDisk,
    milestones: evidence.milestones.map(({ name, time }) => ({ name, time })),
    ...(evidence.failure
      ? { failure: evidence.failure.split("\n")[0].replaceAll(privateOutput, "<PRIVATE>") }
      : {}),
  };
  await writeFile(join(output, "receipt.json"), JSON.stringify(publicReceipt, null, 2));
  candidateServer?.close();
  if (offlineRule)
    await powershell("param([string]$Name) Remove-NetFirewallRule -Name $Name", [
      offlineRule,
    ]).catch(() => {});
  await powershell(
    `param([string]$Executable)
Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $Executable} | ForEach-Object { & taskkill /PID $_.ProcessId /T /F | Out-Null }`,
    [executable],
  ).catch(() => {});
}
