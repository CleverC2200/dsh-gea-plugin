import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { createReadStream, openSync, closeSync } from "node:fs";
import { readFile, writeFile, mkdir, mkdtemp, realpath, stat, readdir } from "node:fs/promises";
import { createServer } from "node:https";
import { createServer as createSocket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { prepareDesktopRelease } from "../desktop-release.mjs";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
const [artifactDirectory, expectedSource, outputDirectory] = process.argv.slice(2);
const output = resolve(outputDirectory);
const root = await realpath(await mkdtemp(join(tmpdir(), "gea-mac-update-")));
const home = join(homedir(), ".dsh");
const userData = join(homedir(), "Library/Application Support/GEA Desktop");
const app = join(root, "Synear GEA.app");
const executable = join(app, "Contents/MacOS/Synear GEA");
const resources = join(app, "Contents/Resources");
const journal = join(root, "journal");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const archive = join(resources, "app.asar");
const dataTool = join(project, "scripts/desktop-update-data.mjs");
const session = "session-" + randomUUID();
const draftKey = "dsh.conversation." + session;
const draft = "Existing Mac composer draft remains after the native update";
const snapshot = join(root, "test-profile.json");
const oldVersion = "0.2.0-rc.2.20261120.1";
const oldHash = "40a643a3d4d228b6b4202863a2103c87d964beab0c3d606ed3fc177e4bb387a3";
const origin = "https://synear-gea.oss-cn-hangzhou.aliyuncs.com";
const hostname = new URL(origin).hostname;
const feedPath = "/client-release/electron/mac-arm64/";
const publishedOld =
  origin +
  "/client-release/raw/1492d73ee280859acf370f93d5bd5da995e44339/desktop/" +
  "Synear-GEA-" +
  oldVersion +
  "-mac-arm64-signed.dmg";
const installedFeedPath = join(resources, "app-update.yml");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/KEY|SECRET|TOKEN|PASSWORD|^DSH_HOME$|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(name),
  ),
);
environment.DSH_DESKTOP_UPDATE_JOURNAL_DIR = journal;
await mkdir(output, { recursive: true });
const result = { status: "failed", from: oldVersion, platform: "mac-arm64", stages: [] };
const requests = [];
let server;
let disk;
const children = [];
const run = (file, args, options = {}) =>
  (
    execFileSync(file, args, {
      encoding: "utf8",
      env: environment,
      timeout: 90000,
      ...options,
    }) ?? ""
  ).trim();

function stage(value) {
  result.stages.push(value);
  console.log("Mac native updater: " + value);
}
async function until(description, read, timeout = 150000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(500);
  }
  throw Error("MAC_NATIVE_UPGRADE_TIMEOUT " + description);
}
async function digest(file) {
  const sha = createHash("sha256");
  for await (const bytes of createReadStream(file)) sha.update(bytes);
  return sha.digest("hex");
}
function version() {
  return run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    join(app, "Contents/Info.plist"),
  ]);
}
function verifyApp() {
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  run("/usr/bin/codesign", [
    "--verify",
    '-R=anchor apple generic and identifier "com.cleverc2200.gea.desktop" and certificate leaf[subject.OU] = "3ARMSMDAJG"',
    app,
  ]);
}
function processRows() {
  return run("/bin/ps", ["-axww", "-o", "pid=,ppid=,command="])
    .split("\n")
    .map((row) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row))
    .filter(Boolean)
    .map(([, pid, parent, command]) => ({ pid: Number(pid), parent: Number(parent), command }));
}
function bundled(args) {
  return run(executable, ["--expose-internals", ...args], {
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
  });
}
async function records() {
  const entries = await readdir(journal).catch(() => []);
  return (
    await Promise.all(
      entries.map(async (name) =>
        (await readFile(join(journal, name), "utf8"))
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          }),
      ),
    )
  ).flat();
}
async function freePort() {
  const socket = createSocket();
  await new Promise((done, reject) => socket.once("error", reject).listen(0, "127.0.0.1", done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}
async function targets(port) {
  return fetch("http://127.0.0.1:" + port + "/json/list", {
    signal: AbortSignal.timeout(1800),
  })
    .then((response) => response.json())
    .catch(() => []);
}
async function evaluate(page, expression) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    return await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(Error("MAC_NATIVE_UPGRADE_CDP_TIMEOUT")), 8000);
      ws.addEventListener(
        "open",
        () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: { expression, awaitPromise: true, returnByValue: true },
            }),
          );
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(Error("MAC_NATIVE_UPGRADE_CDP_CONNECTION"));
        },
        { once: true },
      );
      ws.addEventListener("message", (event) => {
        const reply = JSON.parse(event.data);
        if (reply.id !== 1) return;
        clearTimeout(timer);
        if (reply.error || reply.result.exceptionDetails) {
          reject(Error("MAC_NATIVE_UPGRADE_CDP_EVALUATION"));
        } else done(reply.result.result.value);
      });
    });
  } finally {
    ws.close();
  }
}
async function openWorkspace(flags, phase) {
  const port = await freePort();
  const fd = openSync(join(root, phase + ".log"), "a", 0o600);
  const child = spawn(
    executable,
    ["--remote-debugging-port=" + port, "--remote-debugging-address=127.0.0.1", ...flags],
    { env: environment, cwd: root, stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  children.push(child);
  const page = await until(phase + " workspace", async () => {
    if (child.exitCode !== null) throw Error("MAC_NATIVE_UPGRADE_DESKTOP_EXIT_" + child.exitCode);
    const list = await targets(port);
    const workspace = list.find(
      (row) => row.type === "page" && row.url.startsWith("dsh-app://app/"),
    );
    if (
      workspace &&
      (await evaluate(workspace, "Boolean(window.dshDesktop?.updates?.open)").catch(() => false))
    )
      return workspace;
    const welcome = list.find((row) => row.type === "page" && row.url.includes("welcome"));
    if (welcome)
      await evaluate(welcome, "document.getElementById('company-login')?.click()").catch(() => {});
    return false;
  });
  await until(phase + " Host", () =>
    processRows().some(
      (row) => row.parent === child.pid && row.command.includes("dsh-desktop-host/lib/index.js"),
    ),
  );
  return { child, page, port };
}

try {
  await mkdir(home);
  const profileIdentity = await stat(home);
  const plan =
    artifactDirectory === "baseline"
      ? null
      : await prepareDesktopRelease(resolve(artifactDirectory), expectedSource);
  if (plan) {
    assert.equal(plan.platform, "mac-arm64");
    assert.equal(plan.localCandidate, false);
    assert.notEqual(plan.version, oldVersion);
    result.to = plan.version;
    result.sourceSha = plan.sourceSha;
    result.installerSha256 = plan.files.find((file) => file.name.endsWith(".dmg")).sha256;
    result.updaterArchiveSha256 = plan.files.find((file) => file.name.endsWith(".zip")).sha256;
    result.feedSha256 = plan.files.find((file) => file.name === "nightly-mac.yml").sha256;
  }
  const dmg = join(root, "old.dmg");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      run("/usr/bin/curl", [
        "--fail",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "15",
        "--max-time",
        "75",
        "--continue-at",
        "-",
        "--output",
        dmg,
        publishedOld,
      ]);
      break;
    } catch (error) {
      if ((await digest(dmg).catch(() => null)) === oldHash) break;
      if (attempt === 4) throw error;
    }
  }
  assert.equal(await digest(dmg), oldHash);
  disk = join(root, "old-volume");
  await mkdir(disk);
  run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", disk, dmg]);
  run("/usr/bin/ditto", [join(disk, "Synear GEA.app"), app]);
  run("/usr/bin/hdiutil", ["detach", disk]);
  disk = null;
  assert.equal(version(), oldVersion);
  verifyApp();
  const configured = await readFile(installedFeedPath, "utf8");
  assert.ok(configured.includes("url: " + origin + feedPath));
  assert.ok(configured.includes("channel: nightly"));
  stage("published baseline signature and updater configuration verified");

  const files = new Map(plan?.files.map((file) => [feedPath + file.name, file.path]) ?? []);
  if (!plan) {
    const oldFeed = await fetch(origin + feedPath + "nightly-mac.yml", { redirect: "error" });
    assert.equal(oldFeed.status, 200);
    const bytes = await oldFeed.text();
    assert.match(bytes, /^version: 0\.2\.0-rc\.2\.20261120\.1\s*$/mu);
    const path = join(root, "nightly-mac.yml");
    await writeFile(path, bytes);
    files.set(feedPath + "nightly-mac.yml", path);
  }
  const tlsConfig = join(root, "tls.conf");
  const cert = join(root, "server.crt");
  const key = join(root, "server.key");
  await writeFile(
    tlsConfig,
    "[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=" +
      hostname +
      "\n[extensions]\nsubjectAltName=DNS:" +
      hostname +
      "\n",
  );
  run(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      tlsConfig,
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  const certBytes = await readFile(cert);
  const pin = createHash("sha256")
    .update(new X509Certificate(certBytes).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  server = createServer(
    { key: await readFile(key), cert: certBytes },
    async (request, response) => {
      try {
        const path = new URL(request.url, origin).pathname;
        const file = files.get(path);
        if (!file) return response.writeHead(404).end();
        const { size } = await stat(file);
        const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? "");
        if (request.headers.range && !range) return response.writeHead(416).end();
        const first = range ? Number(range[1]) : 0;
        const last = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (first > last) return response.writeHead(416).end();
        requests.push(basename(path));
        response.writeHead(range ? 206 : 200, {
          "Content-Length": last - first + 1,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          ...(range ? { "Content-Range": "bytes " + first + "-" + last + "/" + size } : {}),
        });
        if (request.method === "HEAD") return response.end();
        await pipeline(createReadStream(file, { start: first, end: last }), response);
      } catch {
        response.destroy();
      }
    },
  );
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const flags = [
    "--no-proxy-server",
    "--user-data-dir=" + userData,
    "--host-resolver-rules=MAP " + hostname + ":443 127.0.0.1:" + server.address().port,
    "--ignore-certificate-errors-spki-list=" + pin,
  ];
  const old = await openWorkspace(flags, "old");
  await until("old workspace ready", async () =>
    (await records()).some((row) => row.version === oldVersion && row.event === "workspace-ready"),
  );
  stage("old workspace and Host ready");
  const settingsPath = join(home, "profiles/desktop/cordis.patch.yml");
  const settings = parseDocument(await readFile(settingsPath, "utf8"));
  assert.equal(settings.errors.length, 0);
  const gea = settings.toJS().findIndex((row) => row.id === "gea-proof");
  assert.ok(gea >= 0);
  settings.setIn([gea, "config", "pluginUpdates", "pollIntervalMs"], 4250);
  await writeFile(settingsPath, settings.toString());
  bundled([
    join(project, "scripts/windows-complete-local/certum-migration.mjs"),
    "--seed-session",
    archive,
    home,
    root,
    session,
  ]);
  const stored = JSON.stringify({ draft, view: null, viewRequest: null });
  assert.equal(
    await evaluate(
      old.page,
      "localStorage.setItem(" +
        JSON.stringify(draftKey) +
        "," +
        JSON.stringify(stored) +
        ");localStorage.getItem(" +
        JSON.stringify(draftKey) +
        ")",
    ),
    stored,
  );
  const before = JSON.parse(bundled([dataTool, "--home", home, "--capture", snapshot]));
  assert.ok(before.sessions >= 1 && before.events >= 3);
  stage("existing conversation, draft and settings captured");
  const previousRequestCount = requests.length;
  const start = Date.now();
  await evaluate(old.page, "window.dshDesktop.updates.open().catch(()=>{}); true");
  const dialog = await until(
    "official update dialog",
    async () => {
      const list = await targets(old.port);
      const page = list.find((row) => row.url.startsWith("dsh-app://shell/update-dialog.html"));
      if (!page) return false;
      const view = await evaluate(page, "window.dshUpdateDialog.status()").catch(() => false);
      if (!view) return false;
      const current = await records();
      const failed = current.find((row) => row.phase === "error" && Date.parse(row.time) >= start);
      if (failed)
        throw Error(
          "MAC_NATIVE_OFFICIAL_UPDATER_ERROR " +
            failed.failedOperation +
            " " +
            (failed.errorCode ?? ""),
        );
      if (!plan)
        return requests.slice(previousRequestCount).includes("nightly-mac.yml") &&
          /up to date|latest|最新/iu.test(JSON.stringify(view))
          ? page
          : false;
      const button = view.buttons?.[0];
      if (
        /download|下载/iu.test(button) &&
        !current.some((row) => row.phase === "downloading" && row.targetVersion === plan.version)
      ) {
        await evaluate(page, "document.querySelector('#actions button').click(); true");
      }
      return /restart|重启|重新启动/iu.test(button) &&
        current.some((row) => row.phase === "ready" && row.targetVersion === plan.version)
        ? page
        : false;
    },
    360000,
  );
  if (!plan) {
    result.status = "baseline-passed";
    stage("official application dialog read the staged baseline feed");
  } else {
    const zipName = plan.files.find((file) => file.name.endsWith(".zip")).name;
    assert.ok(requests.includes(zipName));
    stage("official updater downloaded the exact release ZIP");
    const oldPids = new Set(
      processRows()
        .filter(
          (row) =>
            row.pid === old.child.pid ||
            row.parent === old.child.pid ||
            row.command.startsWith(executable + " "),
        )
        .map((row) => row.pid),
    );
    await evaluate(
      dialog,
      "setTimeout(()=>document.querySelector('#actions button').click(),300); true",
    );
    const successor = await until(
      "original PID exited and new app relaunched",
      () => {
        const rows = processRows();
        if (rows.some((row) => row.pid === old.child.pid)) return false;
        const next = rows.find(
          (row) =>
            !oldPids.has(row.pid) &&
            !row.command.includes(" --expose-internals ") &&
            (row.command === executable || row.command.startsWith(executable + " ")),
        );
        return next && version() === plan.version ? next : false;
      },
      200000,
    );
    stage("native relaunched PID " + successor.pid);
    const newHost = await until("native successor Host", () =>
      processRows().find(
        (row) =>
          row.parent === successor.pid && row.command.includes("dsh-desktop-host/lib/index.js"),
      ),
    );
    await until("native successor Host responds", async () => {
      let listeners;
      try {
        listeners = run("/usr/sbin/lsof", [
          "-nP",
          "-a",
          "-p",
          String(newHost.pid),
          "-iTCP",
          "-sTCP:LISTEN",
          "-Fn",
        ]);
      } catch {
        return false;
      }
      const ports = listeners
        .split("\n")
        .flatMap((line) => /^n(?:127\.0\.0\.1|\*):(\d+)$/u.exec(line)?.[1] ?? []);
      for (const port of ports) {
        const response = await fetch("http://127.0.0.1:" + port + "/", {
          signal: AbortSignal.timeout(2000),
        }).catch(() => null);
        if (response && [200, 401, 403].includes(response.status)) return true;
      }
      return false;
    });
    const windowCheck = join(root, "window.swift");
    await writeFile(
      windowCheck,
      `import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
print(windows.contains {
  guard $0[kCGWindowOwnerPID as String] as? Int == pid,
        $0[kCGWindowLayer as String] as? Int == 0,
        let bounds = $0[kCGWindowBounds as String] as? [String: Double] else { return false }
  return bounds["Width", default: 0] >= 500 && bounds["Height", default: 0] >= 350
})`,
    );
    await until(
      "native successor visible window",
      () => run("/usr/bin/swift", [windowCheck, String(successor.pid)]) === "true",
    );
    verifyApp();
    result.signatureVerified = true;
    assert.ok((await readFile(installedFeedPath, "utf8")).includes("url: " + origin + feedPath));
    assert.equal((await stat(home)).ino, profileIdentity.ino);
    const receipt = join(root, "updated-data.json");
    bundled([dataTool, "--home", home, "--before", snapshot, "--output", receipt]);
    result.data = JSON.parse(await readFile(receipt, "utf8"));
    assert.equal(result.data.status, "passed");
    result.nativeRelaunch = true;
    result.visibleWindow = true;
    result.officialFeedUrlPreserved = true;
    result.profileDirectoryPreserved = true;
    stage("native successor window, Host, history and settings verified");
    process.kill(successor.pid, "SIGTERM");
    await until(
      "native successor exited after verification",
      () => !processRows().some((row) => row.pid === successor.pid),
    );
    const reopened = await openWorkspace([], "draft-readback");
    const stored = await evaluate(
      reopened.page,
      "JSON.parse(localStorage.getItem(" + JSON.stringify(draftKey) + ")??'null')?.draft",
    );
    assert.equal(stored, draft);
    result.composerDraftRetained = true;
    result.status = "passed";
    stage("original composer draft verified");
  }
} catch (error) {
  result.failure = error.message.split("\n")[0].replaceAll(root, "<TEST_ROOT>");
  try {
    result.installedVersionAtFailure = version();
    result.appProcessesAtFailure = processRows()
      .filter((row) => row.command.includes("/Synear GEA.app/Contents/MacOS/Synear GEA"))
      .map(({ pid, parent, command }) => ({
        pid,
        parent,
        host: command.includes("dsh-desktop-host/lib/index.js"),
        executable:
          command.split("/Contents/MacOS/Synear GEA")[0].replaceAll(root, "<TEST_ROOT>") +
          "/Contents/MacOS/Synear GEA",
      }));
  } catch {}
  const caches = join(homedir(), "Library/Caches");
  const shipIt = (await readdir(caches).catch(() => [])).filter((name) =>
    /gea.*shipit/i.test(name),
  );
  result.shipIt = {};
  for (const name of shipIt) {
    for (const log of ["ShipIt_stdout.log", "ShipIt_stderr.log"]) {
      const text = await readFile(join(caches, name, log), "utf8").catch(() => "");
      if (text)
        result.shipIt[log] = text
          .slice(-5000)
          .replaceAll(root, "<TEST_ROOT>")
          .replaceAll(homedir(), "<TEST_USER>")
          .replace(/https?:\/\/[^\s]+/g, "<URL>");
    }
  }
  result.journal = (await records().catch(() => [])).map(
    ({ version, event, phase, targetVersion, failedOperation, errorCode }) => ({
      version,
      event,
      phase,
      targetVersion,
      failedOperation,
      errorCode,
    }),
  );
  throw error;
} finally {
  result.downloads = [...new Set(requests)];
  await writeFile(join(output, "mac-native-upgrade.json"), JSON.stringify(result, null, 2) + "\n");
  for (const child of children) child.kill("SIGTERM");
  server?.closeAllConnections();
  server?.close();
  if (disk) run("/usr/bin/hdiutil", ["detach", disk]);
}
