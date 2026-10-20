import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("./input.mjs", import.meta.url));
const baseline = JSON.parse(
  await readFile(new URL("./released-input.fixture.json", import.meta.url)),
);

async function check(t, input, source = baseline.geaSourceSha) {
  const directory = await mkdtemp(join(tmpdir(), "gea-desktop-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.json");
  await writeFile(path, JSON.stringify(input));
  return spawnSync(process.execPath, [cli, "--input", path, "--source-sha", source], {
    encoding: "utf8",
  });
}

test("complete Windows input refuses missing company archives before building", async (t) => {
  const input = structuredClone(baseline);
  input.seed.packages.pop();
  const result = await check(t, input);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DESKTOP_THREE_PACKAGES_REQUIRED/);
});

test("released three-package identities validate without building or writing outputs", async (t) => {
  const result = await check(t, baseline);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, "input-validated");
  assert.equal(receipt.built, false);
  assert.equal(
    receipt.packages[0].sha256,
    "d570e74a4b782394e6eaef6edefa050092a694698ef81d4c0acd92ab9d140d03",
  );
});

test("complete Windows input refuses a different workflow source", async (t) => {
  const result = await check(t, baseline, "134309645a3bc8fe1a176a4559afbac780ce0316");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DESKTOP_SOURCE_MISMATCH/);
});

test("complete Windows input refuses mutable archives, wrong Core and version rollback", async (t) => {
  const cases = [
    [
      "DESKTOP_ARCHIVE_BINDING_INVALID",
      (input) => {
        input.seed.packages[0].url = input.seed.packages[0].url.replace(
          input.seed.packages[0].sha256,
          "latest",
        );
      },
    ],
    [
      "DESKTOP_ARCHIVE_BINDING_INVALID",
      (input) => {
        input.seed.packages[0].url += "?token=secret";
      },
    ],
    [
      "DESKTOP_ARCHIVE_BINDING_INVALID",
      (input) => {
        input.seed.packages[0].url = input.seed.packages[0].url.replace(
          "synear-gea.oss-cn-hangzhou.aliyuncs.com",
          "example.com",
        );
      },
    ],
    [
      "DESKTOP_ARCHIVE_BINDING_INVALID",
      (input) => {
        input.seed.packages[0].version = "0.1.12";
      },
    ],
    [
      "DESKTOP_THREE_PACKAGES_REQUIRED",
      (input) => {
        input.seed.packages[2] = input.seed.packages[0];
      },
    ],
    [
      "DESKTOP_CORE_INVALID",
      (input) => {
        input.seed.core.head = "a0d854bd72b1d052fe24005cf10b8e72bb8f17f8";
      },
    ],
    [
      "DESKTOP_CORE_INVALID",
      (input) => {
        input.seed.core.artifacts[0].path = "../package.json";
      },
    ],
    [
      "DESKTOP_CORE_INVALID",
      (input) => {
        input.seed.core.artifacts.pop();
      },
    ],
    [
      "DESKTOP_CORE_INVALID",
      (input) => {
        input.seed.core.artifacts[0].sha256 = "0".repeat(64);
      },
    ],
    [
      "DESKTOP_VERSION_INVALID",
      (input) => {
        input.desktopVersion = "0.2.0-rc.2.20261018.1";
      },
    ],
    [
      "DESKTOP_VERSION_INVALID",
      (input) => {
        input.desktopVersion += "+repacked";
      },
    ],
    [
      "DESKTOP_SOURCE_CONFIG_CHANGED",
      (input) => {
        input.seed.source.trustedKeys = [];
      },
    ],
  ];
  for (const [code, change] of cases) {
    const input = structuredClone(baseline);
    change(input);
    const result = await check(t, input);
    assert.notEqual(result.status, 0, code);
    assert.match(result.stderr, new RegExp(code));
  }
});

test("native acceptance bundle input refuses mutable, foreign or incomplete identities", () => {
  const cli = fileURLToPath(new URL("./run-bundle.mjs", import.meta.url));
  const sha = "543df429289ff66f57ba0559fcc89ab3429947a706ca1e1634d3d4689906fdf3";
  const url = `https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/verification/${sha}/native-acceptance.tgz`;
  for (const [value, digest] of [
    [url.replace(sha, "latest"), sha],
    [url.replace("synear-gea.oss-cn-hangzhou.aliyuncs.com", "example.com"), sha],
    [url + "?token=x", sha],
    [url, ""],
  ]) {
    const result = spawnSync(
      process.execPath,
      [cli, "--bundle-url", value, "--bundle-sha256", digest, "--validate-only"],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DESKTOP_NATIVE_BUNDLE_INVALID/);
  }
});
