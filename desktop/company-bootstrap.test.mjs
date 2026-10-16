import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapCompanyProfile,
  readCompanySeed,
} from "./company-bootstrap.mjs";

test("an existing company profile retains configuration, disabled bundles, WeKnora and update receipts byte for byte", async () => {
  const home = await mkdtemp(join(tmpdir(), "gea-bootstrap-existing-"));
  const profile = join(home, "profiles/desktop");
  await mkdir(join(profile, "gea/plugin-updates/operations/old"), {
    recursive: true,
  });
  const files = {
    "package.json": JSON.stringify({
      dependencies: {
        "@cleverc2200/dsh-agent-workbench": "keep",
        "dsh-agent-manage": "keep",
        "@cleverc2200/gea-dsh-prototype": "keep",
        "@changfenhuang/dsh-genui": "keep",
      },
      dsh: { profile: { bundles: ["user-choice"] } },
    }),
    "cordis.patch.yml":
      "- id: gea-proof\n  config:\n    knowledge:\n      baseUrl: https://weknora.example.test\n",
    "gea/plugin-updates/latest.json": '{"id":"old","stage":"completed"}',
    "gea/plugin-updates/operations/old/receipt.json":
      '{"version":"0.0.154","stage":"completed"}',
  };
  for (const [name, text] of Object.entries(files))
    await writeFile(join(profile, name), text);
  const result = await bootstrapCompanyProfile({
    root: "unused",
    support: "unused",
    seed: "unused",
    home,
  });
  assert.deepEqual(result, {
    status: "existing-profile-preserved",
    changed: false,
  });
  for (const [name, text] of Object.entries(files))
    assert.equal(await readFile(join(profile, name), "utf8"), text);
});

test("a damaged bundled archive stops first installation before creating the user profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gea-bootstrap-integrity-"));
  const seed = join(directory, "seed");
  await mkdir(join(seed, "archives"), { recursive: true });
  const names = [
    "@cleverc2200/dsh-agent-workbench",
    "dsh-agent-manage",
    "@cleverc2200/gea-dsh-prototype",
    "@changfenhuang/dsh-genui",
  ];
  await writeFile(join(seed, "archives/first.tgz"), "changed");
  await writeFile(
    join(seed, "manifest.json"),
    JSON.stringify({
      schema: 1,
      packages: names.map((name) => ({
        name,
        version: "1.0.0",
        file: "first.tgz",
        sha256: "0".repeat(64),
      })),
    }),
  );
  const home = join(directory, "home");
  await assert.rejects(
    bootstrapCompanyProfile({ root: "unused", support: "unused", seed, home }),
    /GEA_SEED_ARCHIVE_CHANGED/,
  );
  await assert.rejects(access(home), { code: "ENOENT" });
});

test("the packaged seed rejects missing plugins and paths outside its archives directory", async () => {
  const seed = await mkdtemp(join(tmpdir(), "gea-bootstrap-manifest-"));
  await writeFile(
    join(seed, "manifest.json"),
    JSON.stringify({ schema: 1, packages: [] }),
  );
  await assert.rejects(readCompanySeed(seed), /GEA_SEED_INVALID/);
  const names = [
    "@cleverc2200/dsh-agent-workbench",
    "dsh-agent-manage",
    "@cleverc2200/gea-dsh-prototype",
    "@changfenhuang/dsh-genui",
  ];
  await writeFile(
    join(seed, "manifest.json"),
    JSON.stringify({
      schema: 1,
      packages: names.map((name) => ({
        name,
        version: "1",
        file: "../outside.tgz",
        sha256: "0".repeat(64),
      })),
    }),
  );
  await assert.rejects(readCompanySeed(seed), /GEA_SEED_INVALID/);
});
