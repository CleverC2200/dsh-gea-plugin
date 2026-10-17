import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ciCores } from "../scripts/ci-core-policy.mjs";

const rc2 = "0b9f1f6cd804dd0cc5bbbf76de915ba58c7d5958";
const alpha = "5badb15009ae1756c3afe0ae0cef1faafc290ccc";

test("required and compatibility select disjoint company and upstream Core inputs", () => {
  assert.deepEqual(
    ciCores("required").map((core) => [core.head, core.version]),
    [[rc2, "0.2.0-rc.2"]],
  );
  assert.deepEqual(
    ciCores("compatibility").map((core) => [core.head, core.version]),
    [[alpha, "0.2.1-alpha.1"]],
  );
});

test("an unknown lane cannot silently fall back to a passing baseline", () => {
  assert.throws(() => ciCores("alpha"), /CI_CORE_POLICY_LANE_REQUIRED/);
});

for (const [name, change] of [
  [
    "missing required lane",
    (policy) => {
      delete policy.required;
    },
  ],
  [
    "empty required lane",
    (policy) => {
      policy.required = [];
    },
  ],
  [
    "multiple required baselines",
    (policy) => {
      policy.required.push(policy.compatibility[0]);
    },
  ],
  [
    "overlapping lanes",
    (policy) => {
      policy.compatibility = policy.required;
    },
  ],
  [
    "unknown Core",
    (policy) => {
      policy.required[0].head = "a".repeat(40);
    },
  ],
  [
    "wrong registered version",
    (policy) => {
      policy.required[0].version = "0.2.1-alpha.1";
    },
  ],
  [
    "private Core",
    (policy) => {
      policy.compatibility[0].head = "8ff14441ac932b55cf1f14b1715128eaa162b1ec";
    },
  ],
]) {
  test(`${name} rejects the actual policy at its public reader`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ci-core-policy-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const policy = JSON.parse(
      await readFile(new URL("../scripts/ci-core-policy.json", import.meta.url), "utf8"),
    );
    change(policy);
    await writeFile(join(root, "ci-core-policy.json"), JSON.stringify(policy));
    await writeFile(
      join(root, "supported-cores.json"),
      await readFile(new URL("../scripts/supported-cores.json", import.meta.url)),
    );
    await writeFile(
      join(root, "ci-core-policy.mjs"),
      await readFile(new URL("../scripts/ci-core-policy.mjs", import.meta.url)),
    );
    const reader = await import(pathToFileURL(join(root, "ci-core-policy.mjs")));
    assert.throws(() => reader.ciCores("required"), /CI_CORE_POLICY_/);
  });
}
