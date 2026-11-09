import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

if (process.platform !== "win32") throw Error("WINDOWS_REQUIRED");
const output = resolve(".runtime/published-startup");
const app = join(output, "app");
const root = join(app, "resources/app.asar");
const support = join(app, "resources/runtime");
const home = join(output, "home");
const profile = join(home, "profiles/desktop");
const anchor = join(root, "dsh/node_modules/@deepseek-ai/dsh/package.json");
const mode = process.argv[2];
async function find(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === name) return path;
    if (entry.isDirectory()) { const result = await find(path, name); if (result) return result; }
  }
}
const packages = [
  ["cleverc2200-dsh-agent-workbench-0.1.84.tgz", "5941b11b756dcfa771d0f1f5af1dbb2e71ce124aac134bea452644317c0b43e9"],
  ["dsh-agent-manage-0.6.3-company.59.tgz", "1e20b1429e007317c3b55e5359887f9347f7e3650152664a637d420ffd179ff4"],
  ["cleverc2200-gea-dsh-prototype-0.0.257.tgz", "b3fecf4c719b209a3f168ed2ed28204ccb34bc7eb4c111d2ce511b6c147684c9"],
];
await mkdir(output, { recursive: true });
if (mode === "binding") {
  const bootRequire = createRequire(createRequire(anchor).resolve("@deepseek-ai/dsh-app-boot"));
  try {
    const addon = bootRequire("node-addon-require-builtin");
    const loader = addon.requireBuiltin("internal/modules/esm/loader");
    assert.equal(typeof loader.getOrInitializeCascadedLoader, "function");
    await writeFile(join(output, "binding-" + process.argv[3] + ".json"), JSON.stringify({ status: "loaded", versions: process.versions, binding: addon.getBindingInfo() }, null, 2));
  } catch (error) {
    await writeFile(join(output, "binding-" + process.argv[3] + ".json"), JSON.stringify({ status: "failed", versions: process.versions, diagnostic: inspect(error, { depth: 12 }) }, null, 2));
    throw error;
  }
} else if (mode === "upgrade") {
  const require = createRequire(anchor);
  const store = require("yaml").parse(await readFile(join(profile, "node_modules/.modules.yaml"), "utf8")).storeDir;
  const { runProfilePnpm } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-plugin-manager/operations")));
  const result = await runProfilePnpm({ profile: "desktop", dir: profile, installAnchor: anchor, cwd: profile, home }, [
    "add", ...packages.map(([file]) => "file:" + join(output, file)),
    "--save-exact", "--ignore-scripts", "--ignore-pnpmfile", "--config.auto-install-peers=false", "--config.update-notifier=false", "--store-dir=" + store,
  ], { command: process.execPath, args: ["--expose-internals", join(support, "pnpm/bin/pnpm.mjs")], execution: "service", activateNewBundles: false, outputBytes: 16000, idleTimeoutMs: 120000, lookupTimeoutMs: 30000,
    env: { ELECTRON_RUN_AS_NODE: "1", DSH_DESKTOP_NODE_EXECUTABLE: process.execPath, DSH_HOME: home, PATH: join(support, "bin") + delimiter + process.env.PATH } });
  await writeFile(join(output, "upgrade.json"), JSON.stringify(result, null, 2));
  assert.equal(result.exitCode, 0, result.output);
} else {
  async function download(url, sha, target) {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(180000) });
    assert.equal(response.ok, true, url);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
    await writeFile(target, bytes);
  }
  const installer = await find(resolve(".runtime/candidate"), "GEA-Desktop-0.2.0-rc.2.20261104.4-win-x64-signed.exe");
  assert.ok(installer);
  assert.equal(createHash("sha256").update(await readFile(installer)).digest("hex"), "c540cab3e49b523544b3a0b6440a2e8221ac5ddfa057e66ae7d49a1ecc95d1c2");
  const seven = "C:/Program Files/7-Zip/7z.exe";
  execFileSync(seven, ["x", installer, "-o" + join(output, "outer"), "-y"], { stdio: "ignore" });
  const payload = await find(join(output, "outer"), "app-64.7z");
  assert.ok(payload);
  execFileSync(seven, ["x", payload, "-o" + app, "-y"], { stdio: "ignore" });
  const executable = join(app, "GEA Desktop.exe");
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME: home, LOCALAPPDATA: join(output, "local-app-data") };
  function run(args) { execFileSync(executable, ["--expose-internals", ...args], { env, stdio: "inherit", timeout: 180000 }); }
  const script = resolve(process.argv[1]);
  run([script, "binding", "before"]);
  run([join(root, "company-bootstrap.mjs"), root, support, join(app, "resources/company-seed")]);
  async function host(stage) {
    await mkdir(profile, { recursive: true });
    const child = spawn(executable, ["--expose-internals", join(root, "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js"), join(root, "dsh"), profile, join(support, "primary-runtime"), join(support, "pnpm/bin/pnpm.mjs"), join(support, "bin")], { env, cwd: profile, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16000); });
    try {
      await new Promise((resolveReady, reject) => {
        const timer = setTimeout(() => reject(Error("HOST_READY_TIMEOUT")), 60000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code) => { clearTimeout(timer); reject(Error("HOST_EXIT_" + code)); });
        child.on("message", (message) => {
          if (message.type === "ready") { clearTimeout(timer); resolveReady(); }
          if (message.type === "fatal") { clearTimeout(timer); reject(Error(message.message + "\n" + message.diagnostic)); }
        });
      });
      await writeFile(join(output, "host-" + stage + ".json"), JSON.stringify({ status: "ready" }));
    } catch (error) {
      await writeFile(join(output, "host-" + stage + ".json"), JSON.stringify({ status: "failed", diagnostic: inspect(error, { depth: 12 }), stderr }, null, 2));
      throw error;
    } finally {
      child.kill();
      await new Promise((done) => child.exitCode !== null ? done() : child.once("exit", done));
    }
  }
  await host("before");
  for (const [file, sha] of packages) await download("https://synear-gea.oss-cn-hangzhou.aliyuncs.com/plugin-release/packages/" + sha + "/" + file, sha, join(output, file));
  run([script, "upgrade"]);
  run([script, "binding", "after"]);
  await host("after");
  await writeFile(join(output, "result.json"), JSON.stringify({ status: "published-windows-update-and-host-restart-passed", packages, businessWrites: 0 }, null, 2));
}
