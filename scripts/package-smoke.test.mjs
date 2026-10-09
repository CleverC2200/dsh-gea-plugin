import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pnpm = process.env.GEA_PACKAGE_PNPM;
if (!pnpm) throw Error("GEA_PACKAGE_PNPM_REQUIRED: current official pnpm entry");

test(
  "ordinary GEA artifact locks only runtime dependencies and preserves Host-provided peer contracts",
  { timeout: 120000 },
  async (t) => {
    const work = await mkdtemp(join(tmpdir(), "gea-production-package-"));
    t.after(() => rm(work, { recursive: true, force: true }));
    const versions = {
      "@cleverc2200/gea-dsh-prototype": "0.0.135-candidate.44.9.1",
      "@cleverc2200/dsh-agent-workbench": "0.1.1",
      "dsh-agent-manage": "0.6.3-company.6",
      "@changfenhuang/dsh-genui": "0.11.3",
      "dsh-better-sidebar": "0.24.1",
    };
    const input = join(work, "input"),
      output = join(work, "packages"),
      declared = join(work, "versions.json");
    await writeFile(declared, JSON.stringify(versions));
    execFileSync(
      process.execPath,
      [
        "scripts/prepare-package.mjs",
        "--versions",
        declared,
        "--destination",
        input,
        "--pnpm",
        pnpm,
      ],
      { cwd: root, stdio: "pipe" },
    );
    const packed = JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/package.mjs", "--input", input, "--destination", output],
        { cwd: root, encoding: "utf8" },
      ),
    );
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", packed.artifact, "package/package.json"], { encoding: "utf8" }),
    );
    const lock = JSON.parse(
      execFileSync("tar", ["-xOf", packed.artifact, "package/npm-shrinkwrap.json"], {
        encoding: "utf8",
      }),
    );
    const files = execFileSync("tar", ["-tzf", packed.artifact], { encoding: "utf8" }).split("\n");
    assert.equal(
      manifest.dependencies["@modelcontextprotocol/sdk"],
      "1.30.0",
      "the actual Host import is a shipped runtime dependency",
    );
    assert.equal(manifest.peerDependencies["@deepseek-ai/cordis"], "4.0.5-alpha.1");
    assert.equal(
      manifest.peerDependencies["@cleverc2200/dsh-agent-workbench"],
      versions["@cleverc2200/dsh-agent-workbench"],
    );
    assert.equal(manifest.devDependencies, undefined);
    assert.ok(
      !files.some((file) => file.includes("node_modules/") || file.includes("scripts/start.mjs")),
      "the plugin carries neither another SDK tree nor the retired standalone launcher",
    );
    assert.ok(
      !Object.keys(lock.packages).some(
        (path) =>
          path.includes("node_modules/@deepseek-ai/dsh") ||
          path.includes("node_modules/@deepseek-ai/cordis"),
      ),
      "the official installation provides the SDK singleton",
    );
    assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
    lock.packages[""].dependencies["@modelcontextprotocol/sdk"] = "0.0.0";
    await writeFile(join(input, "npm-shrinkwrap.json"), JSON.stringify(lock));
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["scripts/package.mjs", "--input", input, "--destination", output],
          { cwd: root, stdio: "pipe" },
        ),
      (error) => error.stderr.toString().includes("PRODUCTION_PACKAGE_LOCK_MISMATCH"),
    );
  },
);
