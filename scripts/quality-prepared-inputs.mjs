/** Transfer generated preparation bytes. Source admission, lock installation and quality remain separate. */
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  existsSync,
  readlinkSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { resolve, join, dirname, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isQualityBuildOutput, verifyQualityBuildInventory } from "./quality-ci-stages.mjs";
import { isPreparedWorkbenchOutput } from "./quality-workbench.mjs";
import { readSystemChrome, restoreSystemChromeDirectories } from "./quality-system-chrome.mjs";
import { readRunnerEnvironment, verifyRunnerCompatibility } from "./quality-runner-environment.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fileHash(file) {
  const descriptor = openSync(file, "r"),
    digest = createHash("sha256"),
    buffer = Buffer.alloc(64 * 1024);
  try {
    let count;
    while ((count = readSync(descriptor, buffer)) > 0) digest.update(buffer.subarray(0, count));
    return digest.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const controls = new Set([
  "candidate-input.json",
  "candidate-group.json",
  "quality-stages.json",
  "quality-test-plan.json",
  "quality-test-execution-plan.json",
  "prepared-workbench.json",
  "browser-preparation.json",
  "system-chrome-preparation.json",
]);
const desktopOutputs = [
  "download-differential.cjs",
  "core-asar-reader.cjs",
  "download-differential.LICENSE.txt",
].map((file) => "candidate/dsh-gea-plugin/desktop/" + file);
function refuse(message) {
  throw Error("QUALITY_PREPARED_REJECTED: " + message);
}
function safePath(file) {
  if (
    typeof file !== "string" ||
    !file ||
    isAbsolute(file) ||
    file.includes("\\") ||
    file.includes("\0") ||
    file.split("/").some((part) => !part || part === "." || part === "..")
  )
    refuse("unsafe path");
  return file;
}
function generated(file) {
  if (desktopOutputs.includes(file) || isQualityBuildOutput(file)) return true;
  const workbench = "candidate/dsh-agent-workbench/";
  if (file.startsWith(workbench)) return isPreparedWorkbenchOutput(file.slice(workbench.length));
  return (
    /^(?:\.quality-system-chrome\/|official-latest-standard\/(?:packages|vendor|apps|native)\/.+\/lib\/|official-latest-standard\/apps\/web\/dist\/|quality-upstreams\/upstream-reference\/dsh-better-sidebar\/lib\/|quality-upstreams\/upstream-assets\/genui-0\.11\.3\/|\.quality-browser\/)/.test(
      file,
    ) ||
    /^official-latest-standard\/\.git\/dsh-sdk-(?:artifacts|web|flock)\.json$/.test(file) ||
    new RegExp(
      `^official-latest-standard/native/system/packages/${process.platform}-${process.arch}/.+\\.node$`,
    ).test(file)
  );
}
const equalMap = (left, right) =>
  JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
function outputRoot(file) {
  if (file.startsWith(".quality-system-chrome/")) return ".quality-system-chrome";
  const marker = file.indexOf("/lib/");
  if (marker >= 0) return file.slice(0, marker + 4);
  if (file.startsWith(".quality-browser/")) return file.split("/").slice(0, 2).join("/");
  if (file.startsWith("quality-upstreams/upstream-assets/genui-0.11.3/"))
    return "quality-upstreams/upstream-assets/genui-0.11.3";
  return dirname(file);
}
function checkLink(root, entry) {
  if (
    entry.control ||
    typeof entry.target !== "string" ||
    !entry.target ||
    entry.target.includes("\0") ||
    entry.target.includes("\\")
  )
    refuse("invalid generated symlink");
  const target = resolve(root, dirname(entry.path), entry.target),
    allowed = join(root, outputRoot(entry.path));
  if (!target.startsWith(allowed + "/")) refuse("symlink escapes generated root");
}
function validateEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) refuse("empty inventory");
  const seen = new Set();
  for (const entry of entries) {
    safePath(entry.path);
    if (seen.has(entry.path) || !(controls.has(entry.path) || generated(entry.path)))
      refuse("unexpected or duplicate output: " + entry.path);
    seen.add(entry.path);
    if (
      !["file", "symlink"].includes(entry.type) ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    )
      refuse("invalid file inventory");
    if (
      entry.type === "file" &&
      (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0)
    )
      refuse("invalid file bytes inventory");
    if (entry.control !== controls.has(entry.path)) refuse("invalid control output");
  }
  for (const entry of entries)
    for (let parent = dirname(entry.path); parent !== "."; parent = dirname(parent))
      if (seen.has(parent)) refuse("archive member cannot be an output parent");
}
function context(root, binding) {
  if (
    !binding ||
    typeof binding !== "object" ||
    Array.isArray(binding) ||
    !/^[a-f0-9]{64}$/.test(binding.inputSha256 ?? "") ||
    !/^\d+$/.test(String(binding.runId ?? "")) ||
    !/^[1-9]\d*$/.test(String(binding.runAttempt ?? ""))
  )
    refuse("run binding required");
  for (const [key, value] of Object.entries({
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }))
    if (binding[key] !== value) refuse("environment changed: " + key);
  for (const [key, environment] of [
    ["runId", "GITHUB_RUN_ID"],
    ["runAttempt", "GITHUB_RUN_ATTEMPT"],
  ])
    if (process.env[environment] && String(binding[key]) !== process.env[environment])
      refuse("workflow changed: " + key);
  if (realpathSync(root) !== root) refuse("owned real root required");
}
function sourceIdentity(root, binding) {
  const candidate = binding.manifest;
  if (
    !/^[a-f0-9]{40}$/.test(candidate?.core ?? "") ||
    !Array.isArray(candidate.repositories) ||
    candidate.repositories.length !== 3
  )
    refuse("fixed source tuple required");
  const names = ["dsh-agent-manage", "dsh-agent-workbench", "dsh-gea-plugin"];
  if (
    JSON.stringify(candidate.repositories.map((entry) => entry.repo).sort()) !==
    JSON.stringify([...names].sort())
  )
    refuse("three distinct sources required");
  const materials = candidate.repositories.map((entry) => {
    const expected = join(
      root,
      entry.repo === "dsh-agent-workbench" ? "source" : "candidate",
      entry.repo,
    );
    if (entry.path !== expected || !/^[a-f0-9]{40}$/.test(entry.head ?? ""))
      refuse("source layout or commit changed");
    return {
      repo: entry.repo,
      path: expected,
      head: entry.head,
      lock: entry.repo === "dsh-agent-workbench" ? "package-lock.json" : "pnpm-lock.yaml",
    };
  });
  materials.push({
    repo: "official-core",
    path: join(root, "official-latest-standard"),
    head: candidate.core,
    lock: "pnpm-lock.yaml",
  });
  return materials.map((entry) => {
    const bytes = readFileSync(join(entry.path, "package.json")),
      definition = JSON.parse(bytes);
    if (!/^(?:npm|pnpm)@\d+\.\d+\.\d+$/.test(definition.packageManager ?? ""))
      refuse("declared exact package manager required");
    return {
      ...entry,
      packageSha256: hash(bytes),
      lockSha256: hash(readFileSync(join(entry.path, entry.lock))),
      packageManager: definition.packageManager,
    };
  });
}
function enumerate(root, binding) {
  const entries = [];
  const parents = (file) => {
    for (let path = dirname(join(root, file)); path !== root; path = dirname(path))
      if (
        !path.startsWith(root + "/") ||
        !lstatSync(path).isDirectory() ||
        realpathSync(path) !== path
      )
        refuse("output parent redirected");
  };
  const add = (file) => {
    safePath(file);
    parents(file);
    const path = join(root, file),
      stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const entry = {
        path: file,
        type: "symlink",
        mode: stat.mode & 0o7777,
        target: readlinkSync(path),
        control: controls.has(file),
      };
      checkLink(root, entry);
      const allowed = join(root, outputRoot(file));
      if (!realpathSync(path).startsWith(allowed + "/"))
        refuse("resolved symlink escapes generated root");
      entries.push(entry);
      return;
    }
    if (!stat.isFile()) refuse("regular generated file required: " + file);
    entries.push({
      path: file,
      type: "file",
      mode: stat.mode & 0o7777,
      size: stat.size,
      sha256: fileHash(path),
      control: controls.has(file),
    });
  };
  const tree = (directory) => {
    safePath(directory);
    parents(directory + "/entry");
    const files = {};
    const visit = (prefix) => {
      for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
        const file = prefix + "/" + entry.name;
        if (entry.isDirectory()) visit(file);
        else {
          add(file);
          files[file.slice(directory.length + 1)] = entry.isSymbolicLink()
            ? "link:" + realpathSync(join(root, file))
            : entries.at(-1).sha256;
        }
      }
    };
    visit(directory);
    if (!Object.keys(files).length) refuse("missing generated tree: " + directory);
    return files;
  };
  for (const file of [
    "candidate-input.json",
    "candidate-group.json",
    "quality-stages.json",
    "quality-test-plan.json",
  ])
    add(file);
  if (
    hash(readFileSync(join(root, "candidate-input.json"))) !== binding.inputSha256 ||
    JSON.stringify(json(join(root, "candidate-input.json"))) !== JSON.stringify(binding.manifest)
  )
    refuse("candidate bytes changed");
  const stages = json(join(root, "quality-stages.json"));
  if (
    stages.binding?.inputSha256 !== binding.inputSha256 ||
    ["prepare", "build"].some((stage) => stages.stages?.[stage]?.status !== "passed")
  )
    refuse("passed preparation and build required");
  const expectedRoots = verifyQualityBuildInventory(root, stages.artifacts);
  for (const { root: directory } of expectedRoots)
    if (!equalMap(tree(directory.slice(root.length + 1)), stages.artifacts[directory]))
      refuse("build bytes changed");
  const sdkFile = "official-latest-standard/.git/dsh-sdk-artifacts.json";
  const sdk = json(join(root, sdkFile));
  if (
    sdk.identity?.coreCommit !== binding.manifest.core ||
    sdk.identity.node !== process.version ||
    sdk.identity.platform !== process.platform ||
    sdk.identity.arch !== process.arch
  )
    refuse("SDK identity changed");
  add(sdkFile);
  const roots = new Set(
    Object.keys(sdk.artifacts ?? {}).map((file) => {
      safePath(file);
      const index = file.indexOf("/lib/");
      if (index < 0 || !/^(?:packages|vendor|apps|native)\//.test(file)) refuse("SDK output path");
      return file.slice(0, index + 4);
    }),
  );
  if (!roots.size) refuse("SDK artifacts required");
  const actual = {};
  for (const directory of [...roots].sort())
    for (const [file, digest] of Object.entries(tree("official-latest-standard/" + directory)))
      actual[directory + "/" + file] = digest;
  if (!equalMap(actual, sdk.artifacts)) refuse("SDK bytes changed");
  const plan = json(join(root, "quality-test-plan.json"));
  if (JSON.stringify(plan) !== JSON.stringify(stages.binding.plan)) refuse("selection changed");
  if (plan.files?.includes("scripts/package-desktop.test.mjs"))
    for (const file of desktopOutputs) add(file);
  if (plan.runtime || plan.files?.includes("tests/window-launch-admission.test.mjs")) {
    const file = "official-latest-standard/.git/dsh-sdk-web.json";
    const web = json(join(root, file));
    add(file);
    const expected = Object.fromEntries(
      web.artifacts.map((entry) => {
        safePath(entry.path);
        if (!entry.path.startsWith("apps/web/dist/")) refuse("Web output path");
        return [entry.path.slice("apps/web/dist/".length), entry.sha256];
      }),
    );
    if (!equalMap(tree("official-latest-standard/apps/web/dist"), expected))
      refuse("Web bytes changed");
  }
  if (
    (plan.runtime || plan.files?.some((file) => file.endsWith(".contract.mjs"))) &&
    process.platform !== "win32"
  ) {
    const file = "official-latest-standard/.git/dsh-sdk-flock.json";
    const flock = json(join(root, file));
    add(file);
    const artifact = "official-latest-standard/" + safePath(flock.artifact.path);
    add(artifact);
    if (!generated(artifact) || entries.at(-1).sha256 !== flock.artifact.sha256)
      refuse("native bytes changed");
  }
  if (plan.runtime) {
    add("prepared-workbench.json");
    const prepared = json(join(root, "prepared-workbench.json"));
    const workbench = binding.manifest.repositories.find(
      (entry) => entry.repo === "dsh-agent-workbench",
    );
    if (
      prepared.source !== workbench.path ||
      prepared.prepared !== join(root, "candidate/dsh-agent-workbench") ||
      prepared.head !== workbench.head
    )
      refuse("Workbench identity changed");
    const expected = Object.fromEntries(
      Object.entries(prepared.files)
        .filter(([file]) => file.startsWith("lib/"))
        .map(([file, digest]) => [file.slice(4), digest]),
    );
    const directory = "candidate/dsh-agent-workbench/lib";
    const actual = tree(directory);
    if (!equalMap(actual, expected))
      refuse(
        "Workbench lib changed: " +
          JSON.stringify(
            [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
              .sort()
              .filter((file) => expected[file] !== actual[file])
              .map((file) => ({
                path: directory + "/" + file,
                expected: expected[file] ?? null,
                actual: actual[file] ?? null,
              })),
          ),
      );
    for (const [file, expected] of Object.entries(prepared.files)) {
      if (!isPreparedWorkbenchOutput(file) || file.startsWith("lib/")) continue;
      add("candidate/dsh-agent-workbench/" + safePath(file));
      if (entries.at(-1).sha256 !== expected) refuse("Workbench HTML changed");
    }
  }
  // Even source-only quality stages bind these unchanged link-lock inputs.
  const fixed = json(join(root, "candidate/dsh-gea-plugin/scripts/quality-upstreams.json"));
  if (!equalMap(tree("quality-upstreams/upstream-assets/genui-0.11.3"), fixed.genui.files))
    refuse("GenUI bytes changed");
  tree("quality-upstreams/upstream-reference/dsh-better-sidebar/lib");
  if (plan.browser) {
    add("system-chrome-preparation.json");
    const chromeHashes = tree(".quality-system-chrome");
    readSystemChrome({
      root,
      expected: binding.worker?.browser?.systemChrome,
      verifiedHashes: chromeHashes,
    });
    add("browser-preparation.json");
    const browser = json(join(root, "browser-preparation.json")),
      browserRoot = join(root, ".quality-browser");
    if (
      browser.root !== browserRoot ||
      browser.directories?.length !== 3 ||
      new Set(browser.directories).size !== 3
    )
      refuse("browser roots changed");
    const actual = {};
    for (const directory of browser.directories) {
      if (dirname(directory) !== browserRoot) refuse("browser directory escaped");
      const local = directory.slice(root.length + 1);
      safePath(local);
      for (const [file, digest] of Object.entries(tree(local)))
        actual[join(directory, file)] = digest;
    }
    if (!equalMap(actual, browser.files) || !Object.hasOwn(actual, browser.executable))
      refuse("browser bytes changed");
  }
  if (existsSync(join(root, "quality-test-execution-plan.json")))
    add("quality-test-execution-plan.json");
  validateEntries(entries);
  return entries;
}
function tar(action, root, manifest, bundle) {
  const result = spawnSync(
    "python3",
    [join(import.meta.dirname, "quality-prepared-tar.py"), action, root, manifest, bundle],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) refuse(result.error?.message ?? result.stderr.trim());
}
export function runPreparedTransport(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      binding: { type: "string" },
      bundle: { type: "string" },
      manifest: { type: "string" },
      "manifest-sha256": { type: "string" },
    },
  });
  const [action] = positionals;
  if (
    positionals.length !== 1 ||
    !["export", "receive"].includes(action) ||
    !values.root ||
    !values.binding ||
    !values.bundle ||
    !values.manifest
  )
    refuse("explicit export or receive paths required");
  const root = resolve(values.root),
    manifestFile = resolve(values.manifest),
    bundle = resolve(values.bundle),
    binding = json(values.binding);
  context(root, binding);
  const sources = sourceIdentity(root, binding);
  const environment = readRunnerEnvironment();
  if (action === "export") {
    const manifest = {
      schemaVersion: 1,
      root,
      binding,
      sources,
      environment,
      entries: enumerate(root, binding),
    };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    tar(action, root, manifestFile, bundle);
    manifest.bundleSha256 = fileHash(bundle);
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    return {
      status: "transport-exported",
      manifestSha256: hash(readFileSync(manifestFile)),
      bundleSha256: manifest.bundleSha256,
      files: manifest.entries.length,
    };
  }
  if (
    !/^[a-f0-9]{64}$/.test(values["manifest-sha256"] ?? "") ||
    hash(readFileSync(manifestFile)) !== values["manifest-sha256"]
  )
    refuse("manifest hash changed");
  const manifest = json(manifestFile);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.root !== root ||
    JSON.stringify(manifest.binding) !== JSON.stringify(binding)
  )
    refuse("input binding changed");
  if (JSON.stringify(manifest.sources) !== JSON.stringify(sources))
    refuse("source locks or toolchain declarations changed");
  const observedEnvironment = verifyRunnerCompatibility(manifest.environment, environment);
  validateEntries(manifest.entries);
  for (const entry of manifest.entries) if (entry.type === "symlink") checkLink(root, entry);
  if (fileHash(bundle) !== manifest.bundleSha256) refuse("bundle hash changed");
  tar(action, root, manifestFile, bundle);
  if (json(join(root, "quality-test-plan.json")).browser === true)
    restoreSystemChromeDirectories({ root, expected: binding.worker?.browser?.systemChrome });
  if (
    JSON.stringify(enumerate(root, binding).sort((a, b) => a.path.localeCompare(b.path))) !==
    JSON.stringify([...manifest.entries].sort((a, b) => a.path.localeCompare(b.path)))
  )
    refuse("received inventory incomplete");
  return {
    status: "transport-verified",
    dependencies: "requires-lock-install",
    source: "requires-candidate-admission",
    quality: "not-observed",
    environment: observedEnvironment,
    binding,
    files: manifest.entries.length,
  };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(runPreparedTransport(process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
