import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  openNativeLog,
  observeStableRuntime,
  trackNativeExit,
  stopNativeProcess,
} from "./runtime.mjs";
const execute = promisify(execFile),
  directory = import.meta.dirname;
const r9Case = JSON.parse(await readFile(join(directory, "case.json"), "utf8"));
const { values } = parseArgs({
  options: {
    "build-receipt": { type: "string" },
    input: { type: "string" },
    output: { type: "string" },
  },
});
const output = resolve(values.output),
  buildBytes = await readFile(values["build-receipt"]),
  build = JSON.parse(buildBytes);
const input = JSON.parse(await readFile(values.input, "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(process.platform, "win32");
assert.equal(build.unsigned, false);
assert.equal(build.packaged.version, r9Case.targetVersion);
assert.equal(build.coreSha, r9Case.coreSha);
await mkdir(output);
const privateRoot = join(process.env.RUNNER_TEMP, "gea218-recovery-native");
await mkdir(privateRoot);
const install = join(privateRoot, "installation"),
  executable = join(install, "installed/GEA Desktop.exe");
const appRoot = join(install, "installed/resources/app.asar"),
  support = join(dirname(appRoot), "runtime");
const state = {
  home: join(privateRoot, "dsh-home"),
  appData: join(privateRoot, "app-data"),
  userData: join(privateRoot, "user-data"),
  temp: join(privateRoot, "temp"),
  osHome: join(privateRoot, "os-home"),
};
for (const path of Object.values(state)) await mkdir(path);
const profile = join(state.home, "profiles/desktop");
const env = {
  ...process.env,
  DSH_HOME: state.home,
  DSH_AGENTS_HOME: join(state.home, "agents"),
  HOME: state.osHome,
  USERPROFILE: state.osHome,
  APPDATA: state.appData,
  LOCALAPPDATA: state.appData,
  TEMP: state.temp,
  TMP: state.temp,
  DSH_TELEMETRY_DISABLED: "1",
};
for (const key of Object.keys(env))
  if (/TOKEN|SECRET|PASSWORD|ACCESS_KEY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE/i.test(key))
    delete env[key];
async function fileSha(path) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}
async function download(url, hash, path) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(180000) });
  assert.equal(response.status, 200);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, { flags: "wx" }));
  assert.equal(await fileSha(path), hash);
  return path;
}
async function command(name, file, args, extra = {}) {
  try {
    const result = await execute(file, args, {
      env: { ...env, ...extra },
      timeout: 600000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    await writeFile(join(privateRoot, name + ".log"), result.stdout + result.stderr);
  } catch (error) {
    await writeFile(
      join(privateRoot, name + ".log"),
      String(error.stdout ?? "") + String(error.stderr ?? ""),
    );
    throw Error(name + " failed; retained private log");
  }
}
const baseline = await download(
  r9Case.baselineInstaller.url,
  r9Case.baselineInstaller.sha256,
  join(privateRoot, "old.exe"),
);
const target = join(dirname(dirname(values["build-receipt"])), "artifacts", build.artifact);
assert.equal(await fileSha(target), build.sha256);
const certificate = join(build.geaRoot, "desktop/build/codesign.cer");
async function cover(artifact, version) {
  await command("install-" + version, "powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(directory, "install.ps1"),
    "-Installer",
    artifact,
    "-WorkDirectory",
    install,
    "-ExpectedVersion",
    version,
    "-CertificatePath",
    certificate,
  ]);
}
await cover(baseline, r9Case.baselineVersion);
const artifacts = [];
for (const row of input.seed.packages) {
  const old = row.name === "@cleverc2200/gea-dsh-prototype";
  const version = old ? r9Case.baselineGeaVersion : row.version;
  const hash = old ? r9Case.baselineGeaSha256 : row.sha256;
  const name = row.name.replace(/^@/, "").replace("/", "-") + "-" + version + ".tgz";
  const file = await download(
    "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/plugin-release/packages/" + hash + "/" + name,
    hash,
    join(privateRoot, name),
  );
  artifacts.push({ name: row.name, version, sha256: hash, file });
}
const installInput = join(privateRoot, "install-old.json");
await writeFile(
  installInput,
  JSON.stringify({
    root: appRoot,
    support,
    helperFile: join(appRoot, "company-bootstrap.mjs"),
    home: state.home,
    profile,
    store: join(privateRoot, "store"),
    artifacts,
  }),
);
await command(
  "seed-exact-broken-combination",
  executable,
  ["--expose-internals", join(directory, "install-old.mjs"), installInput],
  { ELECTRON_RUN_AS_NODE: "1" },
);
const historyInput = join(privateRoot, "history.json");
async function history(mode) {
  await writeFile(
    historyInput,
    JSON.stringify({
      root: appRoot,
      home: state.home,
      cwd: state.osHome,
      sessionId: "gea218-preserved-history",
      mode,
    }),
  );
  await command(
    "history-" + mode,
    executable,
    ["--expose-internals", join(directory, "seed-history.mjs"), historyInput],
    { ELECTRON_RUN_AS_NODE: "1" },
  );
}
await history("create");
const draft = join(profile, "recovery-user-draft.json");
await writeFile(
  draft,
  '{"text":"preserved draft","selection":"gea-html-inventory-orderworkbench"}',
);
const draftBefore = await readFile(draft);
const { chromium } = createRequire(
  join(build.geaRoot, ".runtime/fixture-dependencies/package.json"),
)("@playwright/test");
const yaml = createRequire(join(build.coreRoot, "packages/boot/plugin-manager/package.json"))(
  "yaml",
);
const wait = async (test, timeout = 120000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await test();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error("NATIVE_RECOVERY_WAIT_TIMEOUT");
};
const port = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
const patchPath = join(profile, "cordis.patch.yml");
const patch = yaml.parse(await readFile(patchPath, "utf8"));
assert(Array.isArray(patch));
assert(!patch.some((row) => ["webserver", "gea-proof"].includes(row.id)));
patch.push({
  id: "webserver",
  config: {
    host: "127.0.0.1",
    port: await port(),
    compression: "gzip",
    compressionLevel: 1,
    compressionThresholdBytes: 1024,
  },
});
patch.push({
  id: "gea-proof",
  config: {
    runtimeDir: join(profile, "gea"),
    pluginUpdates: {
      source: input.seed.source,
      core: { ...input.seed.core, kind: "desktop", root: appRoot },
      checkTimeoutMs: 60000,
      pollIntervalMs: 2000,
    },
  },
});
patch.push({ id: "locale", config: { preference: "zh" } });
await writeFile(patchPath, yaml.stringify(patch));
for (const row of artifacts)
  assert.equal(
    JSON.parse(await readFile(join(profile, "node_modules", row.name, "package.json"), "utf8"))
      .version,
    row.version,
  );
const installedBaselineProofs = r9Case.installedBaselineProofs;
for (const row of installedBaselineProofs)
  assert.equal(
    await fileSha(join(profile, "node_modules", row.name, row.path)),
    row.sha256,
    "ORIGINAL_INSTALLED_BASELINE_CONTENT_REQUIRED",
  );
async function native(version, repaired) {
  const nodePort = await port(),
    cdpPort = await port();
  const log = await openNativeLog(join(privateRoot, version + ".log"));
  const child = spawn(
    executable,
    [
      "--inspect-brk=127.0.0.1:" + nodePort,
      "--remote-debugging-port=" + cdpPort,
      "--user-data-dir=" + state.userData,
    ],
    { env, stdio: ["ignore", log, log] },
  );
  const exit = trackNativeExit(child);
  let socket, browser, failure, outcome, send;
  try {
    const endpoint = await wait(async () => {
      try {
        return (await (await fetch("http://127.0.0.1:" + nodePort + "/json/list")).json())[0]
          ?.webSocketDebuggerUrl;
      } catch {
        return null;
      }
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map(),
      events = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const task = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) task?.reject(Error(JSON.stringify(message.error)));
        else task?.resolve(message.result);
      } else events.push(message);
    });
    send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    socket.addEventListener("close", () => {
      for (const task of pending.values()) {
        const error = new Error("R9_CDP_CLOSED");
        error.code = "R9_CDP_CLOSED";
        task.reject(error);
      }
      pending.clear();
    });
    await send("Debugger.enable");
    const entryUrl = pathToFileURL(join(appRoot, "official-main.cjs")).href;
    const breakpoint = await send("Debugger.setBreakpointByUrl", { lineNumber: 0, url: entryUrl });
    const takePaused = () =>
      wait(() => {
        const index = events.findIndex((row) => row.method === "Debugger.paused");
        return index < 0 ? null : events.splice(index, 1)[0];
      });
    await send("Runtime.runIfWaitingForDebugger");
    let paused = await takePaused(),
      frame = paused.params.callFrames[0];
    const frameUrl = () =>
      frame.url ||
      events.find(
        (row) =>
          row.method === "Debugger.scriptParsed" && row.params.scriptId === frame.location.scriptId,
      )?.params.url;
    if (frameUrl() !== entryUrl) {
      await send("Debugger.resume");
      paused = await takePaused();
      frame = paused.params.callFrames[0];
    }
    assert.equal(frameUrl(), entryUrl);
    assert.equal(frame.location.lineNumber, 0);
    const source = await send("Debugger.getScriptSource", { scriptId: frame.location.scriptId });
    assert.equal(sha(source.scriptSource), build.entry.sha256);
    const evaluated = await send("Debugger.evaluateOnCallFrame", {
      callFrameId: frame.callFrameId,
      returnByValue: true,
      expression: `(() => { const {app}=require('electron'); const p=require('node:path'); const fs=require('node:fs'); const state=${JSON.stringify(state)}; if(app.isReady()||app.hasSingleInstanceLock())throw Error('ENTRY_ALREADY_STARTED'); if(!app.isPackaged||app.getAppPath()!==${JSON.stringify(appRoot)})throw Error('PACKAGED_ENTRY_REQUIRED'); const version=JSON.parse(fs.readFileSync(p.join(app.getAppPath(),'package.json'),'utf8')).version; if(version!==${JSON.stringify(version)})throw Error('NATIVE_VERSION_MISMATCH'); app.setPath('appData',state.appData); app.setPath('userData',state.userData); app.setPath('sessionData',state.userData); app.setPath('home',state.osHome); app.setPath('temp',state.temp); return {version,packaged:app.isPackaged,beforeReady:!app.isReady(),dshHome:process.env.DSH_HOME}; })()`,
    });
    assert.equal(evaluated.exceptionDetails, undefined);
    assert.equal(evaluated.result.value.version, version);
    assert.equal(evaluated.result.value.dshHome, state.home);
    await send("Debugger.removeBreakpoint", { breakpointId: breakpoint.breakpointId });
    await send("Debugger.resume");
    browser = await wait(async () => {
      try {
        return await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort, { timeout: 1500 });
      } catch {
        return null;
      }
    });
    const context = browser.contexts()[0];
    const page = await wait(() =>
      context.pages().find((page) => page.url().startsWith("dsh-app://app/")),
    );
    const fetchRoutes = () =>
      page
        .evaluate(async () => {
          const rows = [];
          for (const [path, method] of [
            ["/api/gea-html/identity", "GET"],
            ["/api/gea/plugin-updates/status", "POST"],
          ]) {
            try {
              const response = await fetch(path, {
                method,
                ...(method === "POST"
                  ? {
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ pageIdentity: "gea218-native-recovery" }),
                    }
                  : {}),
              });
              rows.push({ path, status: response.status });
            } catch {
              return null;
            }
          }
          return rows;
        })
        .catch(() => null);
    const readInventory = () =>
      page
        .evaluate(async () => {
          const rpcId = crypto.randomUUID();
          const response = await fetch("/api/pluginInventory/list", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "client-request",
              rpcId,
              method: "pluginInventory/list",
              payload: { args: {} },
            }),
            signal: AbortSignal.timeout(10000),
          });
          const result = await response.json();
          return {
            status: response.status,
            correlated: result.rpcId === rpcId,
            ok: result.result?.ok === true,
            errorCode: result.result?.error?.code ?? null,
            gea: Array.isArray(result.result?.value?.entries)
              ? result.result.value.entries
                  .filter((row) => row.moduleName === "@cleverc2200/gea-dsh-prototype")
                  .map(({ entryId, moduleName, enabled, fiberPhase }) => ({
                    entryId,
                    moduleName,
                    enabled,
                    fiberPhase,
                  }))
              : [],
          };
        })
        .catch(() => null);
    const observations = await observeStableRuntime({
      readInventory,
      readRoutes: fetchRoutes,
      phase: repaired ? "active" : "failed",
      status: repaired ? 200 : 404,
    });
    const { inventory, routes: currentRoutes } = observations.second;
    const installedPackages = await Promise.all(
      input.seed.packages.map(async (row) => ({
        name: row.name,
        version: JSON.parse(
          await readFile(join(profile, "node_modules", row.name, "package.json"), "utf8"),
        ).version,
      })),
    );
    await writeFile(
      join(output, (repaired ? "target" : "baseline") + "-observation.json"),
      JSON.stringify(
        {
          version,
          dshHome: state.home,
          profile,
          routes: currentRoutes,
          installedPackages,
          observations,
          pluginInventory: inventory,
          expectedRoutes: repaired ? [200, 200] : [404, 404],
        },
        null,
        2,
      ),
    );
    assert.deepEqual(
      currentRoutes.map((row) => row.status),
      repaired ? [200, 200] : [404, 404],
    );
    for (const row of repaired ? input.seed.packages : artifacts)
      assert.equal(
        installedPackages.find((actual) => actual.name === row.name).version,
        row.version,
      );
    outcome = {
      version,
      normalPackagedMain: true,
      isolatedBeforeReady: true,
      routes: currentRoutes,
      pluginInventory: inventory,
      observations,
    };
    return outcome;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const shutdown = await stopNativeProcess({
      pid: child.pid,
      requestQuit: () => {
        assert(socket?.readyState === WebSocket.OPEN, "R9_QUIT_CONNECTION_REQUIRED");
        return send("Runtime.evaluate", {
          expression: `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(appRoot, "package.json"))})('electron').app.quit()`,
        });
      },
      exited: exit,
      force: () => execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]),
    });
    await writeFile(join(output, version + "-exit.json"), JSON.stringify(shutdown, null, 2));
    if (outcome) outcome.exit = shutdown;
    socket?.close();
    log.end();
    await browser?.close().catch(() => {});
    if (!failure) assert.equal(shutdown.gracefulExit, true, "R9_GRACEFUL_EXIT_REQUIRED");
  }
}
const before = await native(r9Case.baselineVersion, false);
const configBefore = await readFile(join(profile, "cordis.patch.yml"));
await cover(target, build.packaged.version);
const after = await native(build.packaged.version, true);
await history("verify");
assert.deepEqual(await readFile(draft), draftBefore);
const configAfter = await readFile(join(profile, "cordis.patch.yml"));
const beforeRows = yaml.parse(configBefore.toString()),
  afterRows = yaml.parse(configAfter.toString());
const seedAfter = JSON.parse(
  await readFile(join(dirname(appRoot), "company-seed/manifest.json"), "utf8"),
);
const withoutCoreProof = (rows) =>
  rows.map((row) => {
    if (row.id !== "gea-proof") return row;
    const result = structuredClone(row);
    delete result.config.pluginUpdates.core;
    return result;
  });
assert.deepEqual(withoutCoreProof(afterRows), withoutCoreProof(beforeRows));
assert.deepEqual(afterRows.find((row) => row.id === "gea-proof").config.pluginUpdates.core, {
  ...seedAfter.core,
  root: appRoot,
  kind: "desktop",
});
const profileManifest = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
for (const row of input.seed.packages) {
  const installed = JSON.parse(
    await readFile(join(profile, "node_modules", row.name, "package.json"), "utf8"),
  );
  assert.equal(installed.version, row.version);
  assert(profileManifest.dsh.profile.bundles.includes(row.name));
}
await writeFile(
  join(output, "receipt.json"),
  JSON.stringify(
    {
      schemaVersion: 2,
      caseId: r9Case.id,
      acceptanceKind: "historical-signed-overwrite",
      status: "passed",
      actualNativeUpdateAcceptance: true,
      installedBaselineProofs,
      buildReceiptSha256: sha(buildBytes),
      inputSha256: build.inputSha256,
      scenario: "signed installer overwrite from 20261103.1 with the exact W51/M47/old GEA216 mix",
      before,
      after,
      syntheticSessionFixturePreserved: true,
      draftMarkerPreserved: true,
      requiredProfileBundlesPresent: true,
      configurationBytesUnchanged: configBefore.equals(configAfter),
      configurationParsedValuesPreservedExceptCoreProof: true,
      employeeDeviceAcceptance: false,
      realBusinessDraftAcceptance: false,
      businessQueries: 0,
      modelTasks: 0,
    },
    null,
    2,
  ),
);
console.log("Exact broken combination and signed native overwrite recovery passed.");
