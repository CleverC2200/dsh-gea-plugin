import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDevelopmentOutputs, finishDevelopmentOutputs } from "./development-outputs.mjs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: {
    input: { type: "string" },
    repo: { type: "string" },
    target: { type: "string" },
    sha256: { type: "string" },
    destination: { type: "string" },
    base: { type: "string" },
    outputs: { type: "string" },
    "tool-head": { type: "string" },
    runtime: { type: "string" },
  },
  allowPositionals: true,
});
const names = {
  "dsh-agent-workbench": "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage": "dsh-agent-manage",
  "dsh-gea-plugin": "@cleverc2200/gea-dsh-prototype",
};
async function main() {
  const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const toolHead = execFileSync("git", ["-C", toolRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  for (const file of ["plugin-split-development.mjs", "development-outputs.mjs"]) {
    const committed = execFileSync("git", ["-C", toolRoot, "show", "HEAD:scripts/" + file]);
    if (!committed.equals(fs.readFileSync(join(toolRoot, "scripts", file))))
      throw Error("DEVELOPMENT_TOOL_SOURCE_MISMATCH");
  }
  const action = positionals[0];
  if (action === "deliver") {
    if (!/^[a-f0-9]{40}$/.test(values["tool-head"] ?? "") || values["tool-head"] !== toolHead)
      throw Error("DEVELOPMENT_TOOL_HEAD_MISMATCH");
    for (const file of [
      "package.json",
      "scripts/deliver-packages.mjs",
      "scripts/delivery-package-runtime.mjs",
      "scripts/delivery-runtime/package.json",
      "scripts/delivery-runtime/pnpm-lock.yaml",
      "scripts/build-admission.mjs",
      "scripts/development-repositories.mjs",
      "scripts/supported-cores.mjs",
      "scripts/supported-cores.json",
      "scripts/package-source-integrity.mjs",
      "src/shared/plugin-release.mjs",
      "src/capability/html-mcp.mjs",
    ]) {
      const committed = execFileSync("git", ["-C", toolRoot, "show", toolHead + ":" + file]);
      if (!committed.equals(fs.readFileSync(join(toolRoot, file))))
        throw Error("DEVELOPMENT_TOOL_SOURCE_MISMATCH");
    }
    const { readDeliveryRuntime } = await import("./delivery-package-runtime.mjs");
    const runtime = readDeliveryRuntime(values.runtime);
    const input = values.input;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        join(toolRoot, "scripts/delivery-package-runtime.mjs"),
        join(toolRoot, "scripts/deliver-packages.mjs"),
        "--input",
        input ?? "",
        "--destination",
        values.destination ?? "",
      ],
      { cwd: toolRoot, stdio: "inherit", env: { ...process.env, DSH_DELIVERY_RUNTIME: runtime } },
    );
    console.log(JSON.stringify({ toolSource: { path: toolRoot, head: toolHead }, runtime }));
    process.exitCode = result.status ?? 1;
    return;
  }
  const input = values.input ?? process.env.DSH_DEVELOPMENT_INPUT;
  if (!isAbsolute(input ?? "")) throw Error("DEVELOPMENT_FROZEN_INPUT_REQUIRED");
  const data = JSON.parse(fs.readFileSync(input, "utf8"));
  if (data.repositories?.length !== 3) throw Error("DEVELOPMENT_THREE_REPOSITORIES_REQUIRED");
  for (const [repo, name] of Object.entries(names)) {
    const rows = data.repositories.filter((row) => row.repo === repo);
    if (
      rows.length !== 1 ||
      !isAbsolute(rows[0].path ?? "") ||
      !/^[a-f0-9]{40}$/.test(rows[0].head ?? "")
    )
      throw Error("DEVELOPMENT_REPOSITORY_REQUIRED");
    const row = rows[0];
    if (
      JSON.parse(fs.readFileSync(join(row.path, "package.json"), "utf8")).name !== name ||
      execFileSync("git", ["-C", row.path, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim() !== row.head
    )
      throw Error("DEVELOPMENT_SOURCE_MISMATCH");
  }
  const gea = data.repositories.find((row) => row.repo === "dsh-gea-plugin").path;
  const light = ["preflight", "plan"].includes(action);
  const selected = values.repo
    ? data.repositories.filter((row) => row.repo === values.repo)
    : light || action === "check" || action === "report" || action === "finish"
      ? data.repositories
      : [];
  if (!selected.length) throw Error("DEVELOPMENT_REPOSITORY_REQUIRED");
  for (const owner of selected) {
    if (!light) {
      const core = resolve(fs.realpathSync(owner.path), "../../official-latest-standard");
      if (
        !/^[a-f0-9]{40}$/.test(data.core ?? "") ||
        execFileSync("git", ["-C", core, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim() !== data.core
      )
        throw Error("DEVELOPMENT_CORE_MISMATCH");
    }
    const script = action === "package" ? "pack-raw.mjs" : "development-tasks.mjs";
    const file = join(gea, "scripts", script);
    for (const tool of new Set([
      script,
      "build-admission.mjs",
      "development-dependencies.mjs",
      "development-repositories.mjs",
      "development-tasks.mjs",
      "pack-raw.mjs",
      "package-source-integrity.mjs",
    ])) {
      const tracked = execFileSync("git", ["-C", gea, "show", "HEAD:scripts/" + tool]);
      if (!tracked.equals(fs.readFileSync(join(gea, "scripts", tool))))
        throw Error("DEVELOPMENT_TOOL_SOURCE_MISMATCH");
    }
    const args =
      action === "package"
        ? [file, "--input", input, "--repo", owner.repo, "--destination", values.destination ?? ""]
        : [
            file,
            action,
            ...["target", "sha256", "base"]
              .filter((key) => values[key])
              .flatMap((key) => ["--" + key, values[key]]),
            ...(action === "verify" ? ["--input", input] : []),
          ];
    const result = spawnSync(process.execPath, args, {
      cwd: fs.realpathSync(owner.path),
      stdio: "inherit",
    });
    if (result.error || result.status !== 0)
      throw Error(`DEVELOPMENT_TASK_FAILED:${owner.repo}:${result.status ?? result.error?.code}`);
  }
  if (action === "finish" || (action === "report" && values.outputs)) {
    const outputDisposition = action === "finish"
      ? finishDevelopmentOutputs(values.outputs, [input, ...data.repositories.map((row) => fs.realpathSync(row.path))])
      : checkDevelopmentOutputs(values.outputs);
    console.log(
      JSON.stringify({
        status: outputDisposition.status,
        outputDisposition,
        toolSource: { path: toolRoot, head: toolHead },
      }),
    );
    if (action === "finish" && outputDisposition.status === "needs-disposition")
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
