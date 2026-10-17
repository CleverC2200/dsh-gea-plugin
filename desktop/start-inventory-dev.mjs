/** Start the unchanged official Electron shell with local inventory plugins; no installer build. */
import { mkdir, readFile, writeFile, symlink, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
const desktop = import.meta.dirname,
  workspace = resolve(desktop, "../..");
const runtime = join(workspace, "agent-plugin-trials/.runtime/inventory-desktop");
const payload = join(runtime, "payload"),
  data = join(runtime, "user-data");
const electron =
  process.env.GEA_ELECTRON_EXECUTABLE ||
  resolve(
    process.env.HOME,
    "Desktop/GEAUI/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
const installed =
  process.env.GEA_DESKTOP_BASE_PAYLOAD ||
  "/Applications/GEA Desktop.app/Contents/Resources/payload";
if (!existsSync(electron) || !existsSync(join(installed, "node/bin/node")))
  throw Error("请设置 GEA_ELECTRON_EXECUTABLE 和 GEA_DESKTOP_BASE_PAYLOAD");
await mkdir(payload, { recursive: true, mode: 0o700 });
await mkdir(data, { recursive: true, mode: 0o700 });
if (!existsSync(join(payload, "node")))
  await symlink(join(installed, "node"), join(payload, "node"));
await writeFile(
  join(payload, "package.json"),
  JSON.stringify({ name: "dsh-inventory-local-desktop", private: true, type: "module" }),
);
await copyFile(join(desktop, "inventory-dev-runtime.mjs"), join(payload, "start.mjs"));
// Carry deployment choices only; never copy browser cookies or login credentials.
if (!existsSync(join(data, "gea.config.json"))) {
  const patch = JSON.parse(
    await readFile(
      resolve(
        process.env.HOME,
        "Library/Application Support/dsh-gea-desktop/data/deployment.patch.json",
      ),
      "utf8",
    ),
  );
  const active = patch
    .flatMap((r) => [r, ...(r.insert ?? [])])
    .find((r) => r.id === "gea-proof")?.config;
  if (!active || active.analysisSource !== "gea") throw Error("CURRENT_GEA_DEPLOYMENT_UNAVAILABLE");
  const config = {
    geaBaseUrl: active.geaBaseUrl,
    environment: active.environment,
    geaEnvironments: active.geaEnvironments,
    pageSize: active.pageSize ?? 10,
    periodPageSize: active.periodPageSize ?? 100,
    requestTimeoutMs: active.requestTimeoutMs ?? 30000,
    modelRequestTimeoutMs: active.modelRequestTimeoutMs ?? 300000,
    maxSnapshotBytes: active.maxSnapshotBytes ?? 100000,
    analysis: {
      mode: "model",
      source: "gea",
      agentCode: active.analysisAgentCode,
      model: active.analysisModel,
      contextWindow: 128000,
      maxTokens: 16000,
    },
  };
  await writeFile(join(data, "gea.config.json"), JSON.stringify(config), { mode: 0o600 });
}
const env = {
  ...process.env,
  GEA_DESKTOP_PAYLOAD: payload,
  DSH_GEA_DESKTOP_DATA: data,
  GEA_INVENTORY_WORKSPACE: workspace,
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [desktop], { cwd: workspace, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
process.exitCode = await new Promise((done, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => done(code ?? 1));
});
