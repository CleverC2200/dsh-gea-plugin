import { mkdir, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
const payload = process.argv[2];
if (!payload) throw Error("Usage: node desktop/prepare-tools.mjs <new-payload-directory>");
const tools = resolve(payload, "tools");
await mkdir(tools);
for (const file of ["package.json", "package-lock.json"])
  await copyFile(new URL("./tools/" + file, import.meta.url), join(tools, file));
execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["ci", "--prefix", tools, "--ignore-scripts", "--no-audit", "--no-fund"],
  { stdio: "inherit", shell: process.platform === "win32" },
);
