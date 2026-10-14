import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
test("a same-root package-lock with a different transitive graph cannot shadow the explicit npm input", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "gea-profile-lock-priority-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const dependencies = { "decimal.js": "10.6.0" };
  await writeFile(
    join(profile, "package.json"),
    JSON.stringify({ name: "ordinary-profile-lock-fixture", private: true, dependencies }),
  );
  await writeFile(
    join(profile, "pnpm-workspace.yaml"),
    "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n",
  );
  await writeFile(
    join(profile, "npm-shrinkwrap.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies }, "node_modules/decimal.js": { version: "10.6.0" } },
    }),
  );
  const input = await readFile(join(profile, "npm-shrinkwrap.json"));
  const other = JSON.parse(input);
  const dependency = Object.keys(other.packages).find((path) =>
    path.endsWith("node_modules/decimal.js"),
  );
  assert.ok(dependency);
  other.packages[dependency].version = "0.0.0";
  const bytes = JSON.stringify(other);
  await writeFile(join(profile, "package-lock.json"), bytes);
  const receipt = join(profile, "receipt.json");
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "scripts/freeze-package-profile.mjs",
          "--profile",
          profile,
          "--core",
          join(profile, "unopened-core"),
          "--lock",
          join(profile, "npm-shrinkwrap.json"),
          "--receipt",
          receipt,
        ],
        { cwd: resolve(import.meta.dirname, ".."), stdio: "pipe" },
      ),
    (error) => error.stderr.toString().includes("PROFILE_OTHER_NPM_LOCK_PRESENT"),
  );
  assert.equal(await readFile(join(profile, "package-lock.json"), "utf8"), bytes);
  assert.deepEqual(await readFile(join(profile, "npm-shrinkwrap.json")), input);
  await assert.rejects(access(receipt));
});
