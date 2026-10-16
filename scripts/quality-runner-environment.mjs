/** Compare actual runtime consumers while retaining rolling image releases as observations. */
import { readFileSync } from "node:fs";
import { release, version } from "node:os";
const reject = (detail) => {
  throw Error("QUALITY_RUNNER_ENVIRONMENT_REJECTED: " + detail);
};
const required = (value, field) => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim())
    reject("missing or invalid " + field);
  return value;
};
function linuxOS() {
  let source;
  try {
    source = readFileSync("/etc/os-release", "utf8");
  } catch {
    reject("local /etc/os-release required");
  }
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) reject("malformed local os-release");
    let value = match[2];
    if (value.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\["\\$`])*"$/.test(value)) reject("malformed quoted os-release value");
      value = value.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
    } else if (value.startsWith("'")) {
      if (!/^'[^']*'$/.test(value)) reject("malformed quoted os-release value");
      value = value.slice(1, -1);
    } else if (!/^[^\s"'\\$`]*$/.test(value)) reject("malformed os-release value");
    values[match[1]] = value;
  }
  return {
    osId: required(values.ID, "OS ID"),
    osVersionId: required(values.VERSION_ID, "OS VERSION_ID"),
    osDescription: values.PRETTY_NAME ?? "",
  };
}
function validate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    reject("runtime environment required");
  for (const field of [
    "node",
    "platform",
    "arch",
    "imageOS",
    "imageVersion",
    "osId",
    "osVersionId",
    "modules",
    "napi",
  ])
    required(value[field], field);
  if (
    !/^\d+\.\d+\.\d+$/.test(value.node) ||
    !/^\d+$/.test(value.modules) ||
    !/^\d+$/.test(value.napi)
  )
    reject("exact Node/ABI/NAPI required");
  if (value.platform === "linux") {
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(required(value.glibc, "glibc")))
      reject("actual glibc required");
  } else if (value.glibc !== null) reject("non-Linux glibc observation must be null");
}
export function readRunnerEnvironment() {
  const value = {
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    modules: process.versions.modules,
    napi: process.versions.napi,
    glibc: process.report.getReport().header.glibcVersionRuntime ?? null,
  };
  try {
    Object.assign(
      value,
      process.platform === "linux"
        ? linuxOS()
        : { osId: process.platform, osVersionId: release(), osDescription: version() },
    );
    validate(value);
  } catch (error) {
    error.observedEnvironment = value;
    throw error;
  }
  return value;
}
export function verifyRunnerCompatibility(producer, consumer) {
  validate(producer);
  validate(consumer);
  for (const field of [
    "node",
    "platform",
    "arch",
    "imageOS",
    "osId",
    "osVersionId",
    "modules",
    "napi",
    "glibc",
  ])
    if (producer[field] !== consumer[field]) reject("runtime compatibility changed: " + field);
  return {
    producer,
    consumer,
    imageVersionChanged: producer.imageVersion !== consumer.imageVersion,
  };
}
