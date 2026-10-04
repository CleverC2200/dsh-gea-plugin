import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("startup rejects incomplete selection digests and manifest-only changes before launching a Host", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "source-selection-start-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const core = resolve("../../official-latest-standard");
  const coreSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: core,
    encoding: "utf8",
  }).trim();
  const output = join(temporary, "launcher.mjs");
  await writeFile(
    join(temporary, "current-core.json"),
    await readFile("scripts/current-core.json"),
  );
  await build({
    entryPoints: ["scripts/start-isolated-validation.mjs"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    define: { "import.meta.dirname": JSON.stringify(resolve("scripts")) },
    plugins: [
      {
        name: "no-host-process",
        setup(builder) {
          builder.onResolve({ filter: /^node:child_process$/ }, (args) =>
            args.namespace === "no-host-process"
              ? { path: args.path, external: true }
              : { path: args.path, namespace: "no-host-process" },
          );
          builder.onLoad(
            { filter: /.*/, namespace: "no-host-process" },
            () => ({
              contents:
                'export { execFileSync } from "node:child_process"; export function spawn() { throw Error("UNEXPECTED_HOST_START"); }',
            }),
          );
        },
      },
    ],
  });
  const { runSourceProfile } = await import(pathToFileURL(output));
  for (const kind of ["missing", "empty", "null", "manifest-changed"]) {
    const runtime = join(temporary, kind),
      id = randomUUID();
    const directory = join(runtime, "source-combinations", id);
    await mkdir(directory, { recursive: true });
    const record = {
      core: coreSha,
      composition: { id, dependencies: {}, bundles: [], patches: [] },
      files: {},
      externalFiles: {},
      externalRoots: [],
      externalLockFiles: [],
    };
    const bytes = JSON.stringify(record);
    await writeFile(join(directory, "combination.json"), bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const selected =
      kind === "null"
        ? null
        : {
            id,
            ...(kind === "missing"
              ? {}
              : { manifestSha256: kind === "empty" ? "" : hash }),
          };
    const selection = JSON.stringify(selected);
    await writeFile(join(runtime, "source-selection.json"), selection);
    await writeFile(join(runtime, "user-data.txt"), "keep user data");
    if (kind === "manifest-changed") {
      record.composition.patches.push(join(temporary, "other.patch.json"));
      await writeFile(
        join(directory, "combination.json"),
        JSON.stringify(record),
      );
    }
    await assert.rejects(
      runSourceProfile(core, runtime, true),
      /SOURCE_SELECTION_DIGEST_MISMATCH/,
    );
    assert.equal(
      await readFile(join(runtime, "source-selection.json"), "utf8"),
      selection,
    );
    assert.equal(
      await readFile(join(runtime, "user-data.txt"), "utf8"),
      "keep user data",
    );
    await assert.rejects(access(join(runtime, "source-profile.lock")), {
      code: "ENOENT",
    });
    await assert.rejects(
      access(
        join(runtime, "home/profiles/plugin-split-validation/node_modules"),
      ),
      { code: "ENOENT" },
    );
  }
});
