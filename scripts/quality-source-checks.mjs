import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

export const sourceChecks = ["lint", "format:check", "check:knowledge", "check:prompt-execution"];
export const sourceTestCommands = ["test:environment", "test:release-contract"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function sourceCheckBinding({ root, inputSha256 }) {
  if (!/^[a-f0-9]{64}$/.test(inputSha256 ?? "")) throw Error("QUALITY_SOURCE_INPUT_REQUIRED");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const files = [
    ...new Set(
      git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const sources = files.map((file) => {
    const path = resolve(root, file);
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw Error("QUALITY_SOURCE_FILE_REQUIRED");
    return [
      file,
      stat.mode,
      digest(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path)),
    ];
  });
  return {
    inputSha256,
    head: git("rev-parse", "HEAD").trim(),
    sourceSha256: digest(JSON.stringify(sources)),
    platform: process.platform,
    node: process.versions.node,
  };
}

export function verifySourceChecks({ receipt, binding }) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.status !== "passed" ||
    JSON.stringify(receipt.binding) !== JSON.stringify(binding) ||
    !Array.isArray(receipt.checks) ||
    JSON.stringify(receipt.checks.map((check) => check.name)) !== JSON.stringify(sourceChecks) ||
    receipt.checks.some((check) => check.status !== "passed")
  )
    throw Error("QUALITY_SOURCE_RECEIPT_REJECTED");
  return receipt.checks.map((check) => ({ ...check, evidence: "same-frozen-source-receipt" }));
}
