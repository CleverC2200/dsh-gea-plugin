import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { companyPackageNames } from "../../src/shared/plugin-release.mjs";
const [W, M, G] = companyPackageNames;
const defaultCore = {
  head: "a0d854bd72b1d052fe24005cf10b8e72bb8f17f8",
  version: "0.2.0-rc.2",
  sdk: { "@deepseek-ai/dsh-tools": "0.2.0-rc.2" },
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const oldGraph = (geaVersion = "0.0.167") => [
  { name: W, version: "0.1.12", artifactSha256: "a".repeat(64) },
  { name: M, version: "0.6.3-company.21.workbench.1", artifactSha256: "a".repeat(64) },
  {
    name: G,
    version: geaVersion,
    artifactSha256: "a".repeat(64),
    peerDependencies: { [W]: "0.1.12", [M]: "0.6.3-company.21.workbench.1" },
  },
  {
    name: "customer-dashboard",
    version: "1.0.0",
    peerDependencies: { [G]: ">=0.0.167", "@deepseek-ai/dsh-tools": "0.2.0-rc.2" },
  },
];
export async function createReleasePreflightFixture(t, options = {}) {
  const core = options.core ?? defaultCore;
  const root = await mkdtemp(join(tmpdir(), "release-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exports = JSON.parse(
    await readFile(
      new URL("../../scripts/fixtures/plugin-release/production-exports.json", import.meta.url),
      "utf8",
    ),
  );
  const manifests = options.manifests ?? [
    { name: W, version: "0.1.14" },
    { name: M, version: "0.6.3-company.22" },
    {
      name: G,
      version: "0.0.172",
      peerDependencies: {
        [W]: "0.1.12 || 0.1.14",
        [M]: "0.6.3-company.21.workbench.1 || 0.6.3-company.22",
        "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
      },
    },
  ];
  await mkdir(join(root, "packages"));
  const delivery = { stage: "ordinary-three-package-delivery", status: "packaged", packages: [] };
  const input = {
    deliveryManifest: join(root, "manifest.json"),
    schemaVersion: 1,
    sources: [],
    targets: [],
    deployed: [{ id: "current", installed: oldGraph("0.0.171-resubmit.2") }],
    supportedStarts: ["previous-stable", "sales", "resubmit"].map((id, index) => ({
      id,
      core,
      installed: oldGraph(["0.0.167", "0.0.171-sales.1", "0.0.171-resubmit.2"][index]),
    })),
  };
  for (const [index, manifest] of manifests.entries()) {
    const path = join(root, `source-${index}`),
      stage = join(root, `stage-${index}`),
      packed = join(stage, "package");
    await mkdir(path);
    await mkdir(join(packed, "lib"), { recursive: true });
    const contract = exports.find((row) => row.name === manifest.name);
    const final = { ...manifest, exports: contract.exports, dsh: contract.dsh };
    await writeFile(join(path, "package.json"), JSON.stringify(final));
    await mkdir(join(path, "lib"), { recursive: true });
    await writeFile(join(path, "lib/compiler.txt"), "original build output\n");
    await writeFile(
      join(path, index === 0 ? "package-lock.json" : "pnpm-lock.yaml"),
      "lockfileVersion: 9.0\n",
    );
    const git = (...args) =>
      execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "candidate",
    );
    const head = git("rev-parse", "HEAD");
    input.sources.push({ name: manifest.name, path, head, requiredCommits: [head] });
    await writeFile(join(packed, "package.json"), JSON.stringify(final));
    const outputs = [];
    for (const declaration of Object.values(final.exports)) {
      const relative = (typeof declaration === "string" ? declaration : declaration.default).slice(
        2,
      );
      await mkdir(dirname(join(packed, relative)), { recursive: true });
      await writeFile(join(packed, relative), "export default {};\n");
      await mkdir(dirname(join(path, relative)), { recursive: true });
      await writeFile(join(path, relative), "export default {};\n");
      outputs.push({ path: relative, sha256: hash("export default {};\n") });
    }
    await writeFile(join(packed, "cordis.patch.yml"), "[]");
    const lockSha256 = hash(
      await readFile(join(path, index === 0 ? "package-lock.json" : "pnpm-lock.yaml")),
    );
    const buildReceipt = join(root, `${index}-build.json`);
    await writeFile(
      buildReceipt,
      JSON.stringify({
        exitCode: 0,
        sourceHead: head,
        lockSha256,
        command: { file: process.execPath, args: ["build"], cwd: path },
        outputs,
      }),
    );
    const archive = join(root, "packages", `${index}.tgz`);
    execFileSync("tar", ["-czf", archive, "-C", stage, "package"]);
    const metadata = join(root, `${index}-metadata.json`);
    await writeFile(
      metadata,
      JSON.stringify({
        artifactUrl: `https://fixture.invalid/${hash(await readFile(archive))}/plugin.tgz`,
        supportedCores: [core],
        dataCompatibility: { kind: "preserve" },
        notes: "fixture",
      }),
    );
    input.targets.push({ archive, metadata });
    delivery.packages.push({
      name: manifest.name,
      version: manifest.version,
      filename: `${index}.tgz`,
      sha256: hash(await readFile(archive)),
      source: {
        path,
        head,
        lockSha256,
        buildReceipt,
        buildReceiptSha256: hash(await readFile(buildReceipt)),
      },
    });
  }
  await writeFile(input.deliveryManifest, JSON.stringify(delivery));
  const file = join(root, "input.json");
  const run = async (value = input, entry = "scripts/release-preflight.mjs", args = []) => {
    await writeFile(file, JSON.stringify(value));
    return spawnSync(process.execPath, [resolve(entry), "--input", file, ...args], {
      encoding: "utf8",
    });
  };
  return { root, file, input, delivery, run };
}
