import { runQualityChecks } from "./run-quality-checks.mjs";
/** Public source-event admission and fail-closed workflow aggregation. */
import { parseArgs } from "node:util";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { prepareQualityUpstreams, verifyQualityUpstreams } from "./quality-upstreams.mjs";
import {
  readPreparedWorkbench,
  verifyPreparedWorkbench,
  prepareWorkbenchGeaAuthority,
  prepareWorkbenchAssets,
} from "./quality-workbench.mjs";
import { resolveSourceInputs } from "./source-profile.mjs";
import { resourceDigests } from "./source-combination-integrity.mjs";
const peers = {
  "dsh-agent-workbench": "8f58ed601ab048d57f44794658009105407b6ae6",
  "dsh-agent-manage": "6f08567a6e032b867464b0cfc55c967942ce2b93",
};
import { supportedCores } from "./supported-cores.mjs";
import currentCore from "./current-core.json" with { type: "json" };
let finalGroup;
function refuse(code, detail = "") {
  throw Error(code + (detail ? ": " + detail : ""));
}
function admittedCore(head) {
  const core = supportedCores.find((entry) => entry.head === head);
  if (!core) refuse("CANDIDATE_CORE_UNSUPPORTED", head);
  return core;
}
function run(command, args, cwd = process.cwd(), environment = {}) {
  finalGroup?.verifyUnchanged();
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
      "core-head": { type: "string" },
      "prepare-inputs": { type: "boolean" },
      "final-group-sha256": { type: "string" },
      "final-group-workbench": { type: "string" },
    },
  });
  if (values["final-group-sha256"] !== undefined || values["final-group-workbench"] !== undefined) {
    if (
      !values.input ||
      !/^[a-f0-9]{64}$/.test(values["final-group-sha256"] ?? "") ||
      !isAbsolute(values["final-group-workbench"] ?? "")
    )
      refuse(
        "CANDIDATE_FINAL_GROUP_REQUIRED",
        "--input, original bytes --final-group-sha256 and absolute clean source --final-group-workbench required",
      );
    if (!["quality", "prepare", "verify-input"].includes(values.phase))
      refuse("CANDIDATE_FINAL_GROUP_PHASE", values.phase);
  }
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
          core: admittedCore(values["core-head"] ?? currentCore.upstream).head,
          repositories: [
            {
              repo: "dsh-gea-plugin",
              path: resolve(values.root, "candidate/dsh-gea-plugin"),
              head: values.sha,
            },
            ...Object.entries(peers).map(([repo, head]) => ({
              repo,
              path: resolve(
                values.root,
                repo === "dsh-agent-workbench" ? "source" : "candidate",
                repo,
              ),
              head,
            })),
          ],
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    if (!["quality", "prepare", "verify-input"].includes(values.phase))
      refuse("QUALITY_PHASE_REQUIRED", values.phase);
    if (values.phase === "verify-input" && !values["final-group-sha256"])
      refuse("CANDIDATE_FINAL_GROUP_REQUIRED", "verify-input requires the explicit final group");
    const input = values.input ?? process.env.QUALITY_CANDIDATE;
    if (!input) refuse("CANDIDATE_INPUT_REQUIRED", "--input <frozen group JSON>");
    if (values["final-group-sha256"]) {
      // The default source/prepared layout and fixed peers predate this optional interface.
      // Load only the explicitly supplied clean source; the reader validates its manifest root.
      const { readFinalGroup } = await import(
        pathToFileURL(resolve(values["final-group-workbench"], "scripts/candidate-input.mjs"))
      );
      finalGroup = await readFinalGroup({
        input,
        sha256: values["final-group-sha256"],
        checkout: process.cwd(),
        repo: "dsh-gea-plugin",
        coreSource: values["core-source"],
        expectedSha: process.env.QUALITY_EXPECTED_SHA,
        ci: process.env.CI,
      });
      if (values.phase === "verify-input") {
        console.log(JSON.stringify(finalGroup.receipt));
        process.exit(0);
      }
    }
    const candidate = finalGroup?.manifest ?? JSON.parse(readFileSync(resolve(input), "utf8"));
    const coreBaseline = admittedCore(candidate.core);
    if (values["core-head"] && values["core-head"] !== candidate.core)
      refuse("CANDIDATE_CORE_MISMATCH");
    if (candidate.repositories?.length !== 3)
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
      if (
        git("rev-parse", "HEAD") !== entry.head ||
        (!finalGroup && peers[repo] && entry.head !== peers[repo])
      )
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
    if (values["prepare-inputs"])
      await prepareWorkbenchGeaAuthority({ workbench: workbench.path, gea: own.path });
    const preparedWorkbench = resolve(dirname(process.cwd()), "dsh-agent-workbench");
    const workbenchReceipt = resolve(dirname(dirname(process.cwd())), "prepared-workbench.json");
    const workbenchAssetRoot = resolve(
      dirname(dirname(process.cwd())),
      "prepared-workbench-assets",
    );
    const core = resolve(dirname(dirname(process.cwd())), "official-latest-standard"),
      upstream = resolve("../../../current-mainline-closeout-44");
    run(process.execPath, [
      resolve(manage.path, "scripts/prepare-official-sdk.mjs"),
      "--core",
      core,
      "--core-head",
      coreBaseline.head,
      "--consumer",
      process.cwd(),
      "--with-web",
      ...(process.platform === "win32" ? [] : ["--with-flock"]),
      ...(values["prepare-sdk"]
        ? [
            "--prepare",
            "--source",
            values["core-source"] ?? "https://github.com/deepseek-ai/deepseek-harness.git",
          ]
        : []),
    ]);
    if (!existsSync(resolve(core, "apps/web/dist/index.html"))) refuse("QUALITY_CORE_WEB_REQUIRED");
    finalGroup?.verifyUnchanged();
    if (values["prepare-inputs"])
      await prepareQualityUpstreams(existsSync(upstream) ? realpathSync(upstream) : upstream);
    else await verifyQualityUpstreams(upstream);
    run(process.execPath, [
      resolve(workbench.path, "scripts/verify-candidate-input.mjs"),
      "--input",
      resolve(input),
      "--checkout",
      process.cwd(),
      ...(finalGroup ? ["--final-group-sha256", values["final-group-sha256"]] : []),
    ]);
    if (
      Number(process.versions.node.split(".")[0]) !== 24 ||
      execFileSync("corepack", ["pnpm", "--version"], { encoding: "utf8" }).trim() !== "11.27.0"
    )
      refuse("QUALITY_TOOLCHAIN_REQUIRED", "Node 24 / pnpm 11.27.0");
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
    if (values["prepare-inputs"]) {
      if (existsSync(preparedWorkbench))
        refuse(
          "QUALITY_PREPARED_ALREADY_EXISTS",
          "use a fresh owned job directory or verify the existing frozen assets",
        );
      const npmManager = JSON.parse(
        readFileSync(resolve(workbench.path, "package.json")),
      ).packageManager;
      if (
        npmManager !== "npm@11.11.0" ||
        execFileSync("npm", ["--version"], { encoding: "utf8" }).trim() !== npmManager.slice(4)
      )
        refuse("QUALITY_TOOLCHAIN_REQUIRED", "Workbench npm@11.11.0");
      run("git", [
        "-C",
        workbench.path,
        "worktree",
        "add",
        "--detach",
        preparedWorkbench,
        workbench.head,
      ]);
      run(
        "npm",
        ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
        preparedWorkbench,
      );
      run(
        "npm",
        ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
        resolve(preparedWorkbench, "business/inventory-apsplan/source"),
      );
      run(
        "corepack",
        ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
        manage.path,
      );
      run("npm", ["run", "build:core"], preparedWorkbench, {
        DSH_TYPECHECK_PROJECT: "tsconfig.official.json",
        APS_BUILD_MODE: "mock",
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
      const prepared = await readPreparedWorkbench({
        source: workbench.path,
        prepared: preparedWorkbench,
        head: workbench.head,
      });
      finalGroup?.verifyUnchanged();
      writeFileSync(workbenchReceipt, JSON.stringify(prepared, null, 2) + "\n");
      await prepareWorkbenchAssets({
        source: workbench.path,
        prepared: preparedWorkbench,
        head: workbench.head,
        receipt: workbenchReceipt,
        assets: workbenchAssetRoot,
      });
    }
    const workbenchAssets = await verifyPreparedWorkbench({
      source: workbench.path,
      prepared: preparedWorkbench,
      head: workbench.head,
      receipt: workbenchReceipt,
    });
    const upstreamRecord = await verifyQualityUpstreams(upstream);
    const sourcesFile = resolve(dirname(dirname(process.cwd())), "profile-source-inputs.json");
    const records = candidate.repositories.map((entry) => ({
      repo: entry.repo,
      source: entry.path,
      commit: entry.head,
      dependencies: resolve(entry.path, "node_modules"),
    }));
    Object.assign(
      records.find((entry) => entry.repo === "dsh-agent-workbench"),
      {
        assets: workbenchAssetRoot,
        files: workbenchAssets.files,
        dependencies: resolve(preparedWorkbench, "node_modules"),
      },
    );
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
    await resolveSourceInputs(records, { requireEntries: true });
    finalGroup?.verifyUnchanged();
    writeFileSync(sourcesFile, JSON.stringify(records, null, 2) + "\n");
    process.env.GEA_TEST_SOURCE_INPUTS = sourcesFile;
    process.env.GEA_TEST_CANDIDATE = resolve(input);
    const history = resolve("scripts/fixtures/delivery-history/navigation-r7-setup-failure.json");
    const windowInputs = resolve(dirname(dirname(process.cwd())), "source-window-inputs.json");
    writeFileSync(
      windowInputs,
      JSON.stringify(
        {
          ...candidate,
          corePath: core,
          historicalFailure: {
            file: history,
            sha256: createHash("sha256").update(readFileSync(history)).digest("hex"),
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.GEA_TEST_CANDIDATE_INPUTS = windowInputs;
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
    const { chromium } = await import("@playwright/test");
    const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const executable = chromium.executablePath();
    if (!existsSync(executable)) refuse("QUALITY_BROWSER_REQUIRED", executable);
    const dryRun = execFileSync(
      "corepack",
      ["pnpm", "exec", "playwright", "install", "--dry-run", "chromium"],
      {
        encoding: "utf8",
      },
    );
    const browserDirectories = [
      ...new Set([...dryRun.matchAll(/Install location:\s+(.+)/g)].map((match) => match[1].trim())),
    ];
    if (browserDirectories.length !== 3)
      refuse("QUALITY_BROWSER_REQUIRED", "Chromium, headless shell and FFmpeg");
    const browserFiles = {};
    for (const directory of browserDirectories) {
      if (!existsSync(directory)) refuse("QUALITY_BROWSER_REQUIRED", directory);
      const location = relative(realpathSync(browserRoot), realpathSync(directory));
      if (location.startsWith(".." + sep) || isAbsolute(location))
        refuse("QUALITY_BROWSER_REQUIRED", directory);
      const files = await resourceDigests(directory);
      if (Object.keys(files).length === 0) refuse("QUALITY_BROWSER_REQUIRED", directory);
      for (const [file, digest] of Object.entries(files))
        browserFiles[resolve(directory, file)] = digest;
    }
    finalGroup?.verifyUnchanged();
    writeFileSync(
      resolve(dirname(dirname(process.cwd())), "browser-preparation.json"),
      JSON.stringify(
        {
          root: browserRoot,
          executable,
          directories: browserDirectories,
          playwright: JSON.parse(
            readFileSync(resolve("node_modules/@playwright/test/package.json")),
          ).version,
          lockSha256: createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex"),
          files: browserFiles,
        },
        null,
        2,
      ) + "\n",
    );
    if (values.phase === "quality") {
      const checks = runQualityChecks([
        ...(finalGroup
          ? [
              {
                name: "final-group",
                execute: () =>
                  run("corepack", ["pnpm", "test:final-group"], process.cwd(), {
                    GEA_FINAL_GROUP_WORKBENCH_SOURCE: workbench.path,
                    GEA_FINAL_GROUP_MANAGE_SOURCE: manage.path,
                    GEA_FINAL_GROUP_CORE_SOURCE: core,
                  }),
              },
            ]
          : []),
        { name: "fast", execute: () => run("corepack", ["pnpm", "quality:fast"]) },
        { name: "contracts", execute: () => run("corepack", ["pnpm", "test:contracts"]) },
        { name: "full", execute: () => run("corepack", ["pnpm", "test"]) },
      ]);
      writeFileSync(
        resolve(dirname(dirname(process.cwd())), "quality-checks.json"),
        JSON.stringify(checks, null, 2) + "\n",
      );
      if (checks.some((check) => check.status !== "passed"))
        refuse("QUALITY_CHECKS_FAILED", JSON.stringify(checks));
    }
  }
  console.log(
    JSON.stringify({
      status: "passed",
      phase: values.phase,
      runtime: values.phase === "quality" ? "loopback-source-profile-tests" : "not-observed",
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
