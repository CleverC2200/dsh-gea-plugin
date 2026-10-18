/** Historical costs remain estimates only while their measured source inputs still match. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relativeFile = (file) =>
  typeof file === "string" &&
  /^(?:tests|scripts)\//.test(file) &&
  !file.split("/").some((part) => !part || part === "." || part === "..") &&
  !/[\\\0\r\n]/.test(file);

export function currentTestTimings({ timings, root, environment }) {
  if (!timings?.source || !Array.isArray(timings.files))
    throw Error("QUALITY_TEST_TIMINGS_REQUIRED");
  const seen = new Set();
  for (const entry of timings.files) {
    if (
      !relativeFile(entry.file) ||
      seen.has(entry.file) ||
      !Number.isFinite(entry.durationMs) ||
      entry.durationMs < 0
    )
      throw Error("QUALITY_TEST_TIMING_INVALID");
    seen.add(entry.file);
  }
  const sameEnvironment = ["platform", "node", "core", "fileConcurrency"].every(
    (key) => timings.source[key] === environment[key],
  );
  const observed = new Map();
  const matches = (file, sha256) => {
    if (!relativeFile(file) || !/^[a-f0-9]{64}$/.test(sha256 ?? "")) return false;
    if (!observed.has(file)) {
      try {
        observed.set(file, digest(readFileSync(resolve(root, file))));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        observed.set(file, null);
      }
    }
    return observed.get(file) === sha256;
  };
  const invalidated = [];
  const files = timings.files.filter((entry) => {
    const reason =
      timings.schemaVersion !== 2
        ? "unbound-source"
        : !sameEnvironment
          ? "environment-changed"
          : !matches(entry.file, entry.sha256)
            ? "file-changed-or-missing"
            : !Array.isArray(entry.fixtures) ||
                !entry.fixtures.every((file) => matches(file, timings.fixtures?.[file]))
              ? "fixture-changed-or-missing"
              : null;
    if (reason) invalidated.push({ file: entry.file, reason });
    return !reason;
  });
  return {
    source: {
      ...timings.source,
      inputSha256: digest(JSON.stringify(timings)),
      invalidated,
    },
    files,
  };
}
