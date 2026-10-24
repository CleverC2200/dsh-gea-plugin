import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const root = process.env.GITHUB_WORKSPACE;
const reader = resolve(root, "source/dsh-agent-workbench/scripts");
const run = (args, env = process.env) => execFileSync(process.execPath, args, { stdio: "inherit", env });
const tuple = JSON.parse(execFileSync(process.execPath, [resolve(reader, "read-hosted-peer-input.mjs"), "--repo", "dsh-gea-plugin"], {
  encoding: "utf8", env: { ...process.env, QUALITY_EXPECTED_SHA: process.env.SOURCE_HEAD_SHA, QUALITY_SCOPE_ALLOWED: "true", GITHUB_OUTPUT: "" },
}));
const env = { ...process.env, QUALITY_EXPECTED_SHA: process.env.SOURCE_HEAD_SHA,
  QUALITY_BASE_SHA: process.env.SOURCE_BASE_SHA, QUALITY_REUSE_SDK: "true",
  QUALITY_GROUP_GEA: tuple["gea-sha"], QUALITY_GROUP_MANAGE: tuple["manage-sha"],
  QUALITY_GROUP_WORKBENCH: tuple["workbench-sha"], QUALITY_GROUP_ID: tuple["group-id"],
  QUALITY_SOURCE_KIND: tuple["source-kind"], QUALITY_BASELINE_ID: tuple["baseline-id"] };
run([resolve(reader, "write-hosted-group.mjs"), "--repo", "dsh-gea-plugin", "--root", root, "--core-head", "0337d907d0c1305edfa0c915886a203e5e55539d", "--workbench-source"], env);
const input = resolve(root, "candidate-input.json");
const args = ["scripts/run-quality-ci.mjs", "--source-only", "--input", input,
  "--final-group-workbench", resolve(root, "source/dsh-agent-workbench"),
  "--core-source", resolve(root, "source/official-core"), "--final-group-sha256", createHash("sha256").update(readFileSync(input)).digest("hex"),
  "--prepare-inputs", "--prepare-sdk", "--test-file-concurrency", "3"];
run([...args, "--stage", "prepare"], env);
run([...args, "--stage", "build"], env);
