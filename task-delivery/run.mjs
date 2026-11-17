import { readFile, writeFile, mkdir, copyFile, rename, readdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const tool = dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE;
if (!root) throw Error("HOSTED_WORKSPACE_REQUIRED");
const input = JSON.parse(await readFile(join(tool, "input.json"), "utf8"));
const source = (repo) => join(root, "candidate", repo);
const gea = source("dsh-gea-plugin"),
  manage = source("dsh-agent-manage"),
  wb = source("dsh-agent-workbench");
const sdk = join(root, "official-latest-standard"),
  out = join(root, "delivery-output");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const put = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const git = (path, ...args) =>
  execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
const commands = [];
async function run(file, args, cwd = gea) {
  const startedAt = new Date().toISOString();
  const r = spawnSync(file, args, { cwd, stdio: "inherit", env: process.env });
  commands.push({
    file,
    args,
    cwd,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: r.status,
  });
  await put(join(out, "commands.json"), commands);
  if (r.error || r.status !== 0)
    throw Error("DELIVERY_COMMAND_FAILED: " + file + " " + args.join(" "));
}
await mkdir(out);
for (const [repo, head] of Object.entries(input.repositories)) {
  if (!/^[a-f0-9]{40}$/.test(head) || git(source(repo), "rev-parse", "HEAD") !== head)
    throw Error("SOURCE_HEAD_MISMATCH");
  if (git(source(repo), "status", "--porcelain")) throw Error("SOURCE_DIRTY");
  for (const required of input.requiredCommits[repo])
    git(source(repo), "merge-base", "--is-ancestor", required, head);
  if (input.mode === "formal") {
    const version = (await json(join(source(repo), "package.json"))).version;
    if (git(source(repo), "cat-file", "-t", `refs/tags/v${version}`) !== "tag")
      throw Error("ANNOTATED_VERSION_TAG_REQUIRED");
    const manifest = await json(join(source(repo), "package.json"));
    if (git(source(repo), "rev-parse", `v${manifest.version}^{commit}`) !== head)
      throw Error("FORMAL_VERSION_TAG_REQUIRED");
    git(source(repo), "merge-base", "--is-ancestor", head, "origin/main");
  }
}
await run(
  process.execPath,
  [
    join(manage, "scripts/prepare-official-sdk.mjs"),
    "--prepare",
    "--reuse-prepared",
    "--with-flock",
    "--core",
    sdk,
    "--core-head",
    input.core,
    "--source",
    join(root, "source/official-core"),
  ],
  manage,
);
const { prepareQualityUpstreams, bindQualityUpstreamInputs } = await import(
  pathToFileURL(join(gea, "scripts/quality-upstreams.mjs"))
);
await prepareQualityUpstreams(root);
await bindQualityUpstreamInputs(root, join(root, "upstream-inputs"), { prepare: true });
if (process.env.APS_BUILD_MODE) throw Error("PRODUCTION_APS_MODE_REQUIRED");
for (const path of [manage, wb, gea])
  await run(process.execPath, [join(gea, "scripts/development-tasks.mjs"), "prepare"], path);
const aps = join(wb, "business/inventory-apsplan/source");
await run("npm", ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], aps);
for (const [path, target] of [
  [manage, "plugin"],
  [wb, "all"],
  [gea, "plugin"],
])
  await run(
    process.execPath,
    [join(gea, "scripts/development-tasks.mjs"), "build", "--target", target],
    path,
  );
const request = {
  core: { path: sdk, head: input.core, version: "0.2.0-rc.2" },
  pnpm: join(sdk, "apps/desktop/node_modules/pnpm/bin/pnpm.mjs"),
  versions: { "@changfenhuang/dsh-genui": "0.16.0-company.1", "dsh-better-sidebar": "0.24.1" },
  repositories: [],
};
for (const repo of ["dsh-agent-workbench", "dsh-agent-manage", "dsh-gea-plugin"]) {
  const path = source(repo),
    manifest = await json(join(path, "package.json"));
  request.versions[manifest.name] = manifest.version;
  request.repositories.push({
    repo,
    path,
    head: input.repositories[repo],
    buildReceipt: join(
      path,
      ".runtime/development",
      `build-${repo === "dsh-agent-workbench" ? "all" : "plugin"}.json`,
    ),
  });
}
const requestPath = join(out, "request.json");
await put(requestPath, request);
for (const repo of ["dsh-agent-workbench", "dsh-agent-manage"]) {
  const destination = join(root, "raw-" + repo);
  await run(process.execPath, [
    join(gea, "scripts/pack-raw.mjs"),
    "--input",
    requestPath,
    "--repo",
    repo,
    "--destination",
    destination,
  ]);
  const files = (await readdir(destination))
    .filter((x) => x.endsWith(".tgz"))
    .map((x) => join(destination, x));
  if (files.length !== 1) throw Error("RAW_ARCHIVE_REQUIRED");
  request.repositories.find((r) => r.repo === repo).archive = files[0];
}
await put(requestPath, request);
const delivery = join(out, "delivery");
await run(process.execPath, [
  join(gea, "scripts/deliver-packages.mjs"),
  "--input",
  requestPath,
  "--destination",
  delivery,
]);
const origin = "https://synear-gea.oss-cn-hangzhou.aliyuncs.com";
const { parsePluginManifest } = await import(
  pathToFileURL(join(gea, "src/shared/plugin-release.mjs"))
);
const snapshots = await json(join(tool, "deployed-local.json"));
const previous = {},
  references = [];
let publishedManage;
async function download(url, path, expected) {
  const u = new URL(url);
  if (u.origin !== origin || u.username || u.password) throw Error("UNREGISTERED_DOWNLOAD");
  const r = await fetch(u, { redirect: "error", headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) throw Error("DOWNLOAD_FAILED: " + r.status);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (expected && hash(bytes) !== expected) throw Error("DOWNLOAD_HASH_MISMATCH");
  await writeFile(path, bytes, { flag: "wx" });
  return bytes;
}
const downloaded = join(out, "deployed");
await mkdir(downloaded);
for (const channel of ["test", "stable"]) {
  const bytes = await download(
    origin + "/plugin-release/channels/plugin-detail-" + channel + ".json",
    join(downloaded, channel + ".json"),
  );
  const payload = JSON.parse(Buffer.from(JSON.parse(bytes).payloadBase64, "base64"));
  previous[channel] = payload;
  const installed = [];
  for (const [i, ref] of [...payload.releases, ...payload.companionReleases].entries()) {
    const releaseBytes = await download(
        ref.url,
        join(downloaded, channel + "-" + i + ".release.json"),
        ref.sha256,
      ),
      release = JSON.parse(releaseBytes);
    const archive = join(downloaded, channel + "-" + i + ".tgz");
    await download(release.artifact.url, archive, release.artifact.sha256);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }),
    );
    installed.push({ ...parsePluginManifest(manifest), artifactSha256: release.artifact.sha256 });
    if (channel === "test" && release.name === "dsh-agent-manage")
      publishedManage = { archive, release, releaseBytes, ref };
  }
  snapshots.push({ id: "channel-" + channel + "-" + payload.revision, installed });
}
if (!publishedManage) throw Error("PUBLISHED_MANAGE_REQUIRED");
const deliveryManifestPath = join(delivery, "manifest.json"),
  manifest = await json(deliveryManifestPath);
const row = manifest.packages.find((p) => p.name === "dsh-agent-manage");
if (
  row.version !== publishedManage.release.version ||
  git(manage, "rev-parse", `v${row.version}^{commit}`) !== input.repositories["dsh-agent-manage"]
)
  throw Error("PUBLISHED_MANAGE_SOURCE_MISMATCH");
await rename(join(delivery, "packages", row.filename), join(out, "rebuilt-manage-unused.tgz"));
await copyFile(publishedManage.archive, join(delivery, "packages", row.filename));
row.sha256 = publishedManage.release.artifact.sha256;
row.size = publishedManage.release.artifact.size;
row.source = {
  kind: "immutable-published-archive",
  path: manage,
  head: input.repositories["dsh-agent-manage"],
};
await put(deliveryManifestPath, manifest);
await writeFile(
  join(delivery, "SHA256SUMS"),
  manifest.packages.map((r) => r.sha256 + "  packages/" + r.filename).join("\n") + "\n",
);
const registry = await json(join(gea, "scripts/supported-cores.json"));
const supportedCores = registry.map(({ head, version }) => ({ head, version }));
const targets = [],
  sources = [];
for (const row of manifest.packages) {
  const path = source(
    Object.keys(input.repositories).find(
      (repo) => request.repositories.find((r) => r.repo === repo)?.path === row.source.path,
    ),
  );
  sources.push({
    name: row.name,
    path,
    head: row.source.head,
    requiredCommits:
      input.requiredCommits[Object.keys(input.repositories).find((repo) => source(repo) === path)],
  });
  const archive = join(delivery, "packages", row.filename),
    metadata = join(out, row.name.replaceAll("/", "_") + ".metadata.json");
  const old = row.name === "dsh-agent-manage" ? publishedManage.release : undefined;
  await put(metadata, {
    artifactUrl:
      old?.artifact.url ?? origin + "/plugin-release/packages/" + row.sha256 + "/" + row.filename,
    supportedCores: old?.supportedCores ?? supportedCores,
    dataCompatibility: { kind: "preserve" },
    notes:
      old?.notes ??
      "业务接口按当前登录环境隔离；共享记忆保留环境、租户和用户归属；接口日志显示实际请求来源。",
  });
  targets.push({ archive, metadata });
}
const current = snapshots.find((s) => s.id === "current-mac-profile-20261117").installed;
const sdkNames = new Set(
  [...current, ...snapshots.flatMap((s) => s.installed)]
    .flatMap((p) => Object.keys(p.peerDependencies ?? {}))
    .filter((n) => n.startsWith("@deepseek-ai/")),
);
const sdkReaders = [gea, wb, manage].map((p) => createRequire(join(p, "package.json"))),
  sdkVersions = {};
for (const name of sdkNames) {
  let path;
  for (const reader of sdkReaders) {
    try {
      path = reader.resolve(name + "/package.json");
      break;
    } catch {}
  }
  if (!path) throw Error("SDK_PACKAGE_REQUIRED: " + name);
  sdkVersions[name] = (await json(path)).version;
}
const preflightPath = join(out, "preflight.json");
await put(preflightPath, {
  schemaVersion: 1,
  deliveryManifest: deliveryManifestPath,
  sources,
  targets,
  deployed: snapshots,
  environment: {
    core: { head: input.core, version: "0.2.0-rc.2", sdk: sdkVersions },
    installed: current,
  },
});
await run(process.execPath, [join(gea, "scripts/release-preflight.mjs"), "--input", preflightPath]);
for (const [i, target] of targets.entries()) {
  const row = manifest.packages[i],
    destination = join(out, "release-" + i);
  if (row.name === "dsh-agent-manage") {
    await mkdir(destination);
    const filename = publishedManage.ref.sha256 + ".release.json";
    await writeFile(join(destination, filename), publishedManage.releaseBytes);
    references.push({
      name: row.name,
      url: publishedManage.ref.url,
      sha256: publishedManage.ref.sha256,
    });
  } else {
    await run(process.execPath, [
      join(gea, "scripts/create-plugin-release.mjs"),
      "--archive",
      target.archive,
      "--metadata",
      target.metadata,
      "--preflight",
      preflightPath,
      "--destination",
      destination,
    ]);
    const { readdir } = await import("node:fs/promises");
    const [filename] = await readdir(destination);
    const bytes = await readFile(join(destination, filename));
    references.push({
      name: row.name,
      url: origin + "/plugin-release/packages/" + hash(bytes) + "/" + filename,
      sha256: hash(bytes),
    });
  }
}
const { createPluginSuiteChannel, encodePluginChannel } = await import(
  pathToFileURL(join(gea, "scripts/plugin-channel.mjs"))
);
const preflightInput = preflightPath,
  issuedAt = new Date().toISOString(),
  expiresAt = new Date(Date.now() + 180 * 86400000).toISOString();
for (const channel of ["test", "stable"]) {
  const payload = await createPluginSuiteChannel({
    previous: previous[channel],
    preflightInput,
    references,
    revision: previous[channel].revision + 1,
    issuedAt,
    expiresAt,
  });
  await put(join(out, channel + "-channel.json"), encodePluginChannel({ payload }));
}
await run(process.execPath, [
  join(gea, "scripts/plugin-reception.mjs"),
  "--manifest",
  deliveryManifestPath,
  "--core",
  sdk,
  "--pnpm",
  request.pnpm,
  "--home",
  join(root, "reception-home"),
  "--evidence",
  join(out, "reception"),
]);
await put(join(out, "result.json"), {
  status: "prepared-and-received",
  mode: input.mode,
  inputs: input,
  toolHead: process.env.GITHUB_SHA,
  installed: "isolated-official-profile",
  native: "not-observed",
  published: false,
  references,
  previous,
  coreSDK: sdkVersions,
});
