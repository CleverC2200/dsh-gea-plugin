/** Public source-event admission and fail-closed workflow aggregation. */
import { parseArgs } from "node:util";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { prepareQualityUpstreams, verifyQualityUpstreams } from "./quality-upstreams.mjs";
const peers = {
  "dsh-agent-workbench": "9b4863692cb29a3edc8a2358e98feb7846526d1b",
  "dsh-agent-manage": "384ca29c99165db94bd1c17a518fc63befdd6bb7",
};
const coreCommit = "5badb15009ae1756c3afe0ae0cef1faafc290ccc";
function refuse(code, detail = "") {
  throw Error(code + (detail ? ": " + detail : ""));
}
function run(command, args, cwd = process.cwd(), environment = {}) {
  const windows = process.platform === "win32" && ["npm", "corepack"].includes(command);
  const result = spawnSync(windows ? command + ".cmd" : command, args, {
    cwd,
    stdio: "inherit",
    shell: windows,
    env: { ...process.env, ...environment },
  });
  if (result.error || result.signal || result.status !== 0)
    refuse(
      "QUALITY_COMMAND_FAILED",
      command + ": " + (result.error?.message ?? result.signal ?? result.status),
    );
}
try {
  const { values } = parseArgs({
    options: {
      phase: { type: "string", default: "quality" },
      input: { type: "string" },
      root: { type: "string" },
      sha: { type: "string" },
      "prepare-sdk": { type: "boolean" },
      "core-source": { type: "string" },
      "prepare-inputs": { type: "boolean" },
    },
  });
  if (values.phase === "scope") {
    if (process.env.QUALITY_SCOPE_ALLOWED !== "true") throw Error("CANDIDATE_SCOPE_REQUIRED");
  } else if (values.phase === "final") {
    for (const key of ["QUALITY_SCOPE_RESULT", "QUALITY_GATE_RESULT"])
      if (process.env[key] !== "success")
        throw Error("QUALITY_REQUIRED: " + key + "=" + (process.env[key] ?? "missing"));
  } else if (values.phase === "input") {
    if (!values.root || !/^[a-f0-9]{40}$/.test(values.sha ?? ""))
      refuse("CANDIDATE_EVENT_REQUIRED", "--root and actual event --sha");
    writeFileSync(
      resolve(values.root, "candidate-input.json"),
      JSON.stringify(
        {
          core: coreCommit,
          repositories: [
            {
              repo: "dsh-gea-plugin",
              path: resolve(values.root, "candidate/dsh-gea-plugin"),
              head: values.sha,
            },
            ...Object.entries(peers).map(([repo, head]) => ({
              repo,
              path: resolve(values.root, "candidate", repo),
              head,
            })),
          ],
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    if (values.phase !== "quality") refuse("QUALITY_PHASE_REQUIRED", values.phase);
    const input = values.input ?? process.env.QUALITY_CANDIDATE;
    if (!input) refuse("CANDIDATE_INPUT_REQUIRED", "--input <frozen group JSON>");
    const candidate = JSON.parse(readFileSync(resolve(input), "utf8"));
    if (candidate.core !== coreCommit || candidate.repositories?.length !== 3)
      refuse("CANDIDATE_PEER_REQUIRED", "fixed Core and exactly three sources");
    const own = candidate.repositories.find((entry) => entry.repo === "dsh-gea-plugin");
    if (!own || resolve(own.path) !== process.cwd())
      refuse("CANDIDATE_CHECKOUT", "registered GEA checkout required");
    if (process.env.CI && !process.env.QUALITY_EXPECTED_SHA) refuse("CANDIDATE_EVENT_REQUIRED");
    if (process.env.QUALITY_EXPECTED_SHA && own.head !== process.env.QUALITY_EXPECTED_SHA)
      refuse("CANDIDATE_EVENT_MISMATCH");
    // Admit the source event before preparation; the shared full checker follows SDK preparation.
    for (const repo of ["dsh-gea-plugin", ...Object.keys(peers)]) {
      const entries = candidate.repositories.filter((entry) => entry.repo === repo);
      if (entries.length !== 1) refuse("CANDIDATE_PEER_REQUIRED", repo);
      const entry = entries[0],
        git = (...args) =>
          execFileSync("git", ["-C", entry.path, ...args], { encoding: "utf8" }).trim();
      if (git("rev-parse", "HEAD") !== entry.head || (peers[repo] && entry.head !== peers[repo]))
        refuse("CANDIDATE_HEAD", repo);
      if (git("rev-parse", "--is-shallow-repository") !== "false")
        refuse("CANDIDATE_HISTORY_REQUIRED", repo);
      if (git("status", "--porcelain", "--untracked-files=all")) refuse("CANDIDATE_DIRTY", repo);
      const lock = repo === "dsh-agent-workbench" ? "package-lock.json" : "pnpm-lock.yaml";
      if (
        !execFileSync("git", ["-C", entry.path, "show", "HEAD:" + lock]).equals(
          readFileSync(resolve(entry.path, lock)),
        )
      )
        refuse("CANDIDATE_LOCK", repo);
      if (values["prepare-inputs"] && realpathSync(entry.path) !== resolve(entry.path))
        refuse("QUALITY_PRIVATE_PEER_REQUIRED", repo);
    }
    const workbench = candidate.repositories.find((entry) => entry.repo === "dsh-agent-workbench"),
      manage = candidate.repositories.find((entry) => entry.repo === "dsh-agent-manage");
    const core = resolve(dirname(dirname(process.cwd())), "official-latest-standard"),
      upstream = resolve("../../../current-mainline-closeout-44");
    run(process.execPath, [
      resolve(manage.path, "scripts/prepare-official-sdk.mjs"),
      "--core",
      core,
      "--consumer",
      process.cwd(),
      "--with-web",
      ...(values["prepare-sdk"]
        ? [
            "--prepare",
            "--source",
            values["core-source"] ?? "https://github.com/deepseek-ai/deepseek-harness.git",
          ]
        : []),
    ]);
    if (!existsSync(resolve(core, "apps/web/dist/index.html"))) refuse("QUALITY_CORE_WEB_REQUIRED");
    if (values["prepare-inputs"])
      await prepareQualityUpstreams(existsSync(upstream) ? realpathSync(upstream) : upstream);
    else await verifyQualityUpstreams(upstream);
    run(process.execPath, [
      resolve(workbench.path, "scripts/verify-candidate-input.mjs"),
      "--input",
      resolve(input),
      "--checkout",
      process.cwd(),
    ]);
    if (
      Number(process.versions.node.split(".")[0]) !== 24 ||
      execFileSync("corepack", ["pnpm", "--version"], { encoding: "utf8" }).trim() !== "11.27.0"
    )
      refuse("QUALITY_TOOLCHAIN_REQUIRED", "Node 24 / pnpm 11.27.0");
    if (values["prepare-inputs"]) {
      run(
        "npm",
        ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
        workbench.path,
      );
      run(
        "npm",
        ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
        resolve(workbench.path, "business/inventory-apsplan/source"),
      );
      run(
        "corepack",
        ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
        manage.path,
      );
      run("npm", ["run", "build:core"], workbench.path, {
        DSH_TYPECHECK_PROJECT: "tsconfig.official.json",
      });
      run("corepack", ["pnpm", "build"], manage.path);
      run("corepack", [
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--prefer-offline",
      ]);
      run("corepack", ["pnpm", "build:plugin"]);
    }
    for (const entry of candidate.repositories) {
      const source = spawnSync("git", ["-C", entry.path, "remote", "get-url", "source"], {
        encoding: "utf8",
      });
      if (source.status !== 0 && !values["prepare-inputs"])
        refuse("QUALITY_SOURCE_REMOTE_REQUIRED", entry.repo);
      if (source.status !== 0)
        run("git", [
          "-C",
          entry.path,
          "remote",
          "add",
          "source",
          "https://github.com/CleverC2200/" + entry.repo + ".git",
        ]);
    }
    const upstreamRecord = await verifyQualityUpstreams(upstream);
    const sourcesFile = resolve(dirname(dirname(process.cwd())), "profile-source-inputs.json");
    const records = candidate.repositories.map((entry) => ({
      repo: entry.repo,
      source: entry.path,
      commit: entry.head,
      dependencies: resolve(entry.path, "node_modules"),
    }));
    records.push(
      {
        repo: "dsh-genui",
        source: resolve(upstream, "upstream-reference/dsh-genui"),
        commit: upstreamRecord.genui.head,
        assets: resolve(upstream, "upstream-assets/genui-0.11.3"),
        files: upstreamRecord.genui.files,
        dependencies: resolve(process.cwd(), "node_modules"),
      },
      {
        repo: "dsh-better-sidebar",
        source: resolve(upstream, "upstream-reference/dsh-better-sidebar"),
        commit: upstreamRecord.sidebar.head,
        dependencies: resolve(upstream, "upstream-reference/dsh-better-sidebar/node_modules"),
      },
    );
    writeFileSync(sourcesFile, JSON.stringify(records, null, 2) + "\n");
    process.env.GEA_TEST_SOURCE_INPUTS = sourcesFile;
    process.env.GEA_TEST_CANDIDATE = resolve(input);
    process.env.GEA_TEST_SOURCE_CORE = "1";
    process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(
      dirname(dirname(process.cwd())),
      ".quality-browser",
    );
    if (values["prepare-inputs"])
      run("corepack", [
        "pnpm",
        "exec",
        "playwright",
        "install",
        ...(process.platform === "linux" ? ["--with-deps"] : []),
        "chromium",
      ]);
    run("corepack", ["pnpm", "quality:fast"]);
    run("corepack", ["pnpm", "test:contracts"]);
    run("corepack", ["pnpm", "test"]);
  }
  console.log(JSON.stringify({ status: "passed", phase: values.phase, runtime: "not-observed" }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
