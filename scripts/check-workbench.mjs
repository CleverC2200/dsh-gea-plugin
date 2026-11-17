import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const [name, ...supplied] = process.argv.slice(2);
const root = process.cwd();
const commands = {
  comments: ["check-source-comments.mjs", ["--root", root]],
  knowledge: [
    "check-agent-knowledge.mjs",
    ["--root", root, "--config", "docs/agent-knowledge.json"],
  ],
  "official-input": [
    "verify-official-input.mjs",
    ["--root", root, "--registry", resolve(root, "scripts/supported-cores.json")],
  ],
};
if (!Object.hasOwn(commands, name))
  throw Error("WORKBENCH_CHECK_REQUIRED: comments, knowledge or official-input");
if (name === "official-input" && supplied.length)
  throw Error("WORKBENCH_CONSUMER_INPUT_REQUIRED: official-input uses the current repository");
const workbench = resolve(
  process.env.DSH_WORKBENCH_CHECKOUT ?? resolve(import.meta.dirname, "../../dsh-agent-workbench"),
);
const [script, args] = commands[name];
const tool = resolve(workbench, "scripts", script);
if (!existsSync(tool))
  throw Error(
    `WORKBENCH_TOOL_REQUIRED: ${tool}; set DSH_WORKBENCH_CHECKOUT to the prepared Workbench checkout`,
  );
const official = name === "official-input";
const result = spawnSync(
  process.execPath,
  [tool, ...args, ...supplied],
  official ? { encoding: "utf8" } : { stdio: "inherit" },
);
if (result.error) throw result.error;
if (official) {
  if (result.status === 0) {
    let receipt;
    try {
      receipt = JSON.parse(result.stdout);
    } catch {}
    if (
      receipt?.status !== "passed" ||
      receipt.consumer !== root ||
      receipt.registry !== resolve(root, "scripts/supported-cores.json")
    )
      throw Error(
        `WORKBENCH_CONSUMER_RECEIPT_REQUIRED: ${tool}; select a Workbench checkout supporting explicit consumer input`,
      );
  }
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
}
process.exitCode = result.status ?? 1;
