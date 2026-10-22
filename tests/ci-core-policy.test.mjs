import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { ciCores } from "../scripts/ci-core-policy.mjs";

const rc2 = "6f88c3ea2d266ba1825d88bab10d92479a6ffde8";
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

test("source and manual type workflows execute the required Core policy instead of adaptation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hosted-required-core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gea = join(root, "candidate/dsh-gea-plugin");
  await mkdir(join(gea, "scripts"), { recursive: true });
  for (const file of ["ci-core-policy.mjs", "ci-core-policy.json", "supported-cores.json"])
    await writeFile(
      join(gea, "scripts", file),
      await readFile(new URL("../scripts/" + file, import.meta.url)),
    );
  await writeFile(
    join(gea, "scripts/current-core.json"),
    JSON.stringify({ adaptation: "b".repeat(40) }),
  );
  for (const [file, id, cwd] of [
    ["source-quality.yml", "core", gea],
    ["delivery-fixtures.yml", "source-types-core", root],
  ]) {
    const workflow = await readFile(
      new URL("../.github/workflows/" + file, import.meta.url),
      "utf8",
    );
    const command = workflow.match(new RegExp("id: " + id + "\\n\\s*run: (.+)"))[1];
    const output = join(root, id + "-output");
    const result = spawnSync("sh", ["-c", command], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(output, "utf8"), `head=${rc2}\n`);
  }
});
