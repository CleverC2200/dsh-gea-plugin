import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = process.env.RELEASE_ROOT;
const out = path.join(root, "release-output");
await fs.mkdir(out, { recursive: true });
const digest = (x) => createHash("sha256").update(x).digest("hex");
const json = async (p) => JSON.parse(await fs.readFile(p));
const write = async (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2) + "\n");
const repos = ["dsh-agent-workbench", "dsh-agent-manage", "dsh-gea-plugin"];
const owners = repos.map((repo) => ({ repo, path: path.join(root, "candidate", repo) }));
const gea = owners[2].path;
const run = (file, args, cwd, label) => {
  const r = spawnSync(file, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return fs
    .writeFile(path.join(out, label + ".log"), (r.stdout ?? "") + "\n" + (r.stderr ?? ""))
    .then(() => {
      assert.equal(r.status, 0, label);
      return r.stdout;
    });
};
const readRemote = async (url) => {
  const r = await fetch(url);
  assert.equal(r.status, 200, url);
  return Buffer.from(await r.arrayBuffer());
};
const origin = "https://synear-gea.oss-cn-hangzhou.aliyuncs.com";
const published = [];
const channels = {};
for (const channel of ["test", "stable"]) {
  const envelope = JSON.parse(
    await readRemote(origin + "/plugin-release/channels/plugin-detail-" + channel + ".json"),
  );
  const payload = JSON.parse(Buffer.from(envelope.payloadBase64, "base64"));
  channels[channel] = payload;
  for (const ref of [...payload.releases, ...payload.companionReleases]) {
    const bytes = await readRemote(ref.url);
    assert.equal(digest(bytes), ref.sha256);
    const release = JSON.parse(bytes);
    published.push(release);
  }
}
await write(path.join(out, "channels-before.json"), channels);
await write(path.join(out, "published-before.json"), published);
const versions = { "@changfenhuang/dsh-genui": "0.16.0-company.1", "dsh-better-sidebar": "0.24.1" };
for (const owner of owners) {
  owner.head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: owner.path,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["merge-base", "--is-ancestor", owner.head, "origin/main"], {
    cwd: owner.path,
  });
  const pkg = await json(path.join(owner.path, "package.json"));
  assert.equal(
    execFileSync("git", ["rev-parse", "v" + pkg.version + "^{commit}"], {
      cwd: owner.path,
      encoding: "utf8",
    }).trim(),
    owner.head,
  );
  versions[pkg.name] = pkg.version;
  const npm = pkg.packageManager.startsWith("npm@");
  await run(
    "node",
    [
      "--input-type=module",
      "-e",
      `import {developmentTask} from ${JSON.stringify(path.join(gea, "scripts/development-tasks.mjs"))};console.log(JSON.stringify(await developmentTask('prepare')))`,
    ],
    owner.path,
    owner.repo + "-prepare",
  );
  if (owner.repo === "dsh-agent-workbench")
    await run(
      "npm",
      ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
      path.join(owner.path, "business/inventory-apsplan/source"),
      owner.repo + "-aps-prepare",
    );
  const command = {
    file: npm ? "npm" : "corepack",
    args: npm ? ["run", "build"] : ["pnpm", "run", "build"],
    cwd: owner.path,
  };
  await run(command.file, command.args, command.cwd, owner.repo + "-build");
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner.path, encoding: "utf8" }).trim(),
    owner.head,
  );
  const outputs = [];
  const walk = async (dir) => {
    for (const ent of await fs.readdir(path.join(owner.path, dir), { withFileTypes: true })) {
      const name = dir + "/" + ent.name;
      if (ent.isDirectory()) await walk(name);
      else {
        assert(ent.isFile());
        outputs.push({
          path: name,
          sha256: digest(await fs.readFile(path.join(owner.path, name))),
        });
      }
    }
  };
  await walk("lib");
  if (owner.repo === "dsh-agent-manage") await walk("client");
  owner.buildReceipt = path.join(out, owner.repo + "-build.json");
  await write(owner.buildReceipt, {
    command,
    exitCode: 0,
    sourceHead: owner.head,
    lockSha256: digest(
      await fs.readFile(path.join(owner.path, npm ? "package-lock.json" : "pnpm-lock.yaml")),
    ),
    outputs,
    logPath: path.join(out, owner.repo + "-build.log"),
  });
  await run(
    "tar",
    [
      "-czf",
      path.join(out, owner.repo + "-outputs.tar.gz"),
      "lib",
      ...(owner.repo === "dsh-agent-manage" ? ["client"] : []),
    ],
    owner.path,
    owner.repo + "-outputs",
  );
  if (owner.repo !== "dsh-gea-plugin") {
    const raw = path.join(out, "raw-" + owner.repo);
    await fs.mkdir(raw);
    const packed = JSON.parse(
      await run(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", raw],
        owner.path,
        owner.repo + "-pack",
      ),
    );
    owner.archive = path.join(raw, packed[0].filename);
  }
}
const core = {
  path: path.join(root, "official-latest-standard"),
  head: "0accab310546c1bc8d3ad46b8803dcbcfaa02477",
  version: "0.2.0-rc.2",
};
const pnpm = path.join(core.path, "apps/desktop/node_modules/pnpm/bin/pnpm.mjs");
const request = { core, pnpm, versions, repositories: owners };
await write(path.join(out, "request.json"), request);
const delivery = path.join(out, "delivery");
await run(
  "node",
  [
    "scripts/deliver-packages.mjs",
    "--input",
    path.join(out, "request.json"),
    "--destination",
    delivery,
  ],
  gea,
  "delivery",
);
const manifest = await json(path.join(delivery, "manifest.json"));
const manage = manifest.packages.find((x) => x.repo === "dsh-agent-manage");
const reuse = published.find((x) => x.name === manage.name && x.version === manage.version);
assert(reuse, "MANAGE_IMMUTABLE_PUBLISHED_REQUIRED");
const bytes = await readRemote(reuse.artifact.url);
assert.equal(digest(bytes), reuse.artifact.sha256);
await fs.writeFile(path.join(delivery, "packages", manage.filename), bytes);
manage.sha256 = reuse.artifact.sha256;
manage.source = { path: owners[1].path, head: owners[1].head, kind: "immutable-published-archive" };
delete manage.sourceArchiveSha256;
await write(path.join(delivery, "manifest.json"), manifest);
await fs.writeFile(
  path.join(delivery, "SHA256SUMS"),
  manifest.packages.map((x) => x.sha256 + "  " + x.filename).join("\n") + "\n",
);
const template = await json(
  path.join(process.env.GITHUB_WORKSPACE, "tools/scripts/remote-sales-release-template.json"),
);
const installed = published.map((x) => ({
  name: x.name,
  version: x.version,
  peerDependencies: x.peerDependencies,
  peerDependenciesMeta: x.peerDependenciesMeta,
  dependencies: x.dependencies,
  artifactSha256: x.artifact.sha256,
  geaPluginUpdateStrategy: x.geaPluginUpdateStrategy,
}));
const preflight = {
  schemaVersion: 1,
  deliveryManifest: path.join(delivery, "manifest.json"),
  sources: [],
  targets: [],
  deployed: [...template.deployed, { id: "current-channel-readback", installed }],
  environment: template.environment,
};
for (const pkg of manifest.packages) {
  const owner = owners.find((x) => x.repo === pkg.repo);
  const metadata = {
    artifactUrl: origin + "/plugin-release/packages/" + pkg.sha256 + "/" + pkg.filename,
    supportedCores: manifest.supportedCores,
    dataCompatibility: { kind: "preserve" },
    notes: "销售预测结果核对、纠偏整数数量和调整明细、动态问法与全选；保留已有配置与数据。",
  };
  const metadataPath = path.join(out, pkg.repo + "-metadata.json");
  await write(metadataPath, metadata);
  preflight.sources.push({
    name: pkg.name,
    path: owner.path,
    head: owner.head,
    requiredCommits: [owner.head],
  });
  preflight.targets.push({
    archive: path.join(delivery, "packages", pkg.filename),
    metadata: metadataPath,
  });
}
const preflightPath = path.join(out, "preflight.json");
await write(preflightPath, preflight);
await run("node", ["scripts/release-preflight.mjs", "--input", preflightPath], gea, "preflight");
await run(
  "node",
  [
    "scripts/plugin-reception.mjs",
    "--manifest",
    path.join(delivery, "manifest.json"),
    "--core",
    core.path,
    "--pnpm",
    pnpm,
    "--home",
    path.join(root, "release-reception-home"),
    "--evidence",
    path.join(out, "reception"),
  ],
  gea,
  "reception",
);
const references = [];
for (let i = 0; i < manifest.packages.length; i++) {
  const pkg = manifest.packages[i];
  const target = preflight.targets[i];
  const destination = path.join(out, "release-" + pkg.repo);
  const created = JSON.parse(
    await run(
      "node",
      [
        "scripts/create-plugin-release.mjs",
        "--archive",
        target.archive,
        "--metadata",
        target.metadata,
        "--preflight",
        preflightPath,
        "--destination",
        destination,
      ],
      gea,
      pkg.repo + "-release",
    ),
  );
  await write(path.join(out, pkg.repo + "-projection.json"), created);
  references.push({
    name: pkg.name,
    url:
      origin +
      "/plugin-release/packages/" +
      created.sha256 +
      "/" +
      created.sha256 +
      ".release.json",
    sha256: created.sha256,
  });
}
const { createPluginSuiteChannel, encodePluginChannel } = await import(
  path.join(gea, "scripts/plugin-channel.mjs")
);
for (const owner of owners) {
  const main = execFileSync("git", ["ls-remote", "origin", "refs/heads/main"], {
    cwd: owner.path,
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)[0];
  if (owner.repo !== "dsh-agent-manage") assert.equal(main, owner.head, "MAIN_ADVANCED");
}
for (const channel of ["test", "stable"]) {
  const refreshed = JSON.parse(
    await readRemote(origin + "/plugin-release/channels/plugin-detail-" + channel + ".json"),
  );
  const previous = JSON.parse(Buffer.from(refreshed.payloadBase64, "base64"));
  assert.deepEqual(previous, channels[channel], "CHANNEL_ADVANCED");
  const payload = await createPluginSuiteChannel({
    previous,
    preflightInput: preflightPath,
    references,
    revision: previous.revision + 1,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 180 * 86400000).toISOString(),
  });
  await write(path.join(out, "channel-" + channel + "-new.json"), encodePluginChannel({ payload }));
}
await write(path.join(out, "remote-complete.json"), {
  status: "artifacts-ready-not-published",
  request,
  versions,
  runId: process.env.GITHUB_RUN_ID,
  toolHead: process.env.GITHUB_SHA,
  references,
});
