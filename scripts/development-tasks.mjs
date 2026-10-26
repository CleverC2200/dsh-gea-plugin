import fs from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { managedPackages } from "./development-repositories.mjs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  repository,
  dependencyInput,
  prepareDependencies,
  digest,
  json,
  run,
  installed,
  verifyDevelopmentSDK,
} from "./development-dependencies.mjs";
import { readBuildAdmissions, withBuildAdmission } from "./build-admission.mjs";
import { checkDevelopmentOutputs } from "./development-outputs.mjs";

function walk(root, prefix = "") {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw Error("DEVELOPMENT_OUTPUT_LINK_FORBIDDEN");
    return entry.isDirectory()
      ? walk(join(root, entry.name), name)
      : [{ path: name, sha256: digest(fs.readFileSync(join(root, entry.name))) }];
  });
}
function outputPaths(owner, target) {
  if (owner.repo === "dsh-gea-plugin")
    return (target === "plugin" ? ["host", "client"] : [target]).map((name) => `lib/${name}.js`);
  if (owner.repo === "dsh-agent-manage")
    return target === "client" ? ["client"] : ["lib", "client"];
  return ["lib"];
}
function outputs(owner, target) {
  const groups = outputPaths(owner, target).map((file) => {
    const path = join(owner.path, file);
    if (!fs.existsSync(path)) return [];
    if (fs.lstatSync(path).isSymbolicLink()) throw Error("DEVELOPMENT_OUTPUT_LINK_FORBIDDEN");
    return fs.statSync(path).isDirectory()
      ? walk(path, file)
      : [{ path: file, sha256: digest(fs.readFileSync(path)) }];
  });
  return groups.some((files) => !files.length) ? null : groups.flat();
}
function sources(root, include = () => true) {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  return files
    .filter(
      (file) =>
        include(file) &&
        !/^(?:lib|client|tests|docs|docs-site|\.agents|\.github|\.codex)\//.test(file) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
        !/^(?:README|AGENTS|CLAUDE|QUALITY|CONTRIBUTING|CHANGELOG|SECURITY)/.test(file),
    )
    .sort()
    .map((file) => {
      const path = join(root, file);
      return [file, fs.existsSync(path) ? digest(fs.readFileSync(path)) : null];
    });
}
async function buildInput(owner, target) {
  const peers = [];
  if (owner.repo === "dsh-agent-workbench") {
    const path = resolve(owner.path, "../dsh-agent-manage");
    if (fs.existsSync(join(path, "package.json")))
      peers.push({
        path,
        files: sources(path, (file) =>
          /^(?:business-resources\/|src\/(?:inventory-compute|aps-compute)\/|package\.json$)/.test(
            file,
          ),
        ),
      });
  }
  if (owner.repo !== "dsh-gea-plugin") {
    const path = resolve(owner.path, "../dsh-gea-plugin");
    if (fs.existsSync(join(path, "package.json")))
      peers.push({
        path,
        files: ["build-admission", "development-dependencies", "development-repositories"].map(
          (name) => {
            const file = `scripts/${name}.mjs`;
            return [
              file,
              fs.existsSync(join(path, file)) ? digest(fs.readFileSync(join(path, file))) : null,
            ];
          },
        ),
      });
  }
  return {
    target,
    dependencies: dependencyInput(owner, { build: true }),
    installed: installed(owner, { build: true }),
    sdk: await verifyDevelopmentSDK(owner),
    sources: [{ path: owner.path, files: sources(owner.path) }, ...peers],
    environment: Object.fromEntries(
      [
        "NODE_ENV",
        "NODE_OPTIONS",
        "DSH_BUILD_FACE",
        "DSH_BUSINESS_BUILD_MOCK",
        "DSH_CORE_CHECKOUT",
        "APS_BUILD_MODE",
      ].map((key) => [key, process.env[key] ?? null]),
    ),
  };
}
function command(owner, script) {
  return owner.manager === "npm" ? ["npm", ["run", script]] : ["corepack", ["pnpm", "run", script]];
}
async function build(owner, target) {
  const scripts = {
    "dsh-agent-workbench": { plugin: "build:core", all: "build" },
    "dsh-agent-manage": { plugin: "build", client: "build:client" },
    "dsh-gea-plugin": { plugin: "build:plugin", host: "build:host", client: "build:client" },
  };
  const script = scripts[owner.repo][target];
  if (!script) throw Error("DEVELOPMENT_BUILD_TARGET_REQUIRED");
  for (const dir of new Set(outputPaths(owner, target).map((file) => file.split("/")[0]))) {
    const path = join(owner.path, dir);
    if (fs.existsSync(path) && fs.lstatSync(path).isSymbolicLink())
      throw Error("DEVELOPMENT_OUTPUT_LINK_FORBIDDEN");
  }
  const input = await buildInput(owner, target);
  const receipt = join(owner.path, ".runtime/development", `build-${target}.json`);
  if (fs.existsSync(receipt)) {
    const previous = json(receipt);
    if (
      JSON.stringify(previous.input) === JSON.stringify(input) &&
      previous.outputs?.length &&
      JSON.stringify(previous.outputs) === JSON.stringify(outputs(owner, target))
    ) {
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: owner.path,
        encoding: "utf8",
      }).trim();
      if (head !== previous.sourceHead)
        fs.writeFileSync(
          receipt,
          JSON.stringify(
            {
              ...previous,
              compiledSourceHead: previous.compiledSourceHead ?? previous.sourceHead,
              sourceHead: head,
              lastVerifiedAt: new Date().toISOString(),
            },
            null,
            2,
          ) + "\n",
        );
      return { status: "reused", receipt };
    }
  }
  return withBuildAdmission({ operation: "build", cwd: owner.path }, async () => {
    const [file, args] = command(owner, script);
    run(file, args, owner.path);
    if (JSON.stringify(await buildInput(owner, target)) !== JSON.stringify(input))
      throw Error("DEVELOPMENT_INPUT_CHANGED");
    const files = outputs(owner, target);
    if (!files?.length) throw Error("DEVELOPMENT_BUILD_OUTPUT_REQUIRED");
    fs.mkdirSync(join(owner.path, ".runtime/development"), { recursive: true });
    fs.writeFileSync(
      receipt,
      JSON.stringify(
        {
          schemaVersion: 1,
          input,
          outputs: files,
          sourceHead: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: owner.path,
            encoding: "utf8",
          }).trim(),
          lockSha256: digest(fs.readFileSync(join(owner.path, owner.lock))),
          exitCode: 0,
          command: { file, args, cwd: owner.path },
          createdAt: new Date().toISOString(),
          owner: process.env.CODEX_THREAD_ID ?? owner.path,
          purpose: "development-build",
          retention: "regenerable-after-reader-and-input-review",
          generated: outputPaths(owner, target),
        },
        null,
        2,
      ) + "\n",
    );
    return { status: "built", receipt };
  });
}
function localSourceTask(action, values, cwd) {
  const path = fs.realpathSync(cwd);
  const manifest = json(join(path, "package.json"));
  const repo = Object.keys(managedPackages).find((name) => managedPackages[name] === manifest.name);
  if (!repo) throw Error("DEVELOPMENT_REPOSITORY_REQUIRED");
  const invoke = (file, args) => {
    const checked = spawnSync(process.execPath, [file, ...args], {
      cwd: path,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: "",
        GITHUB_EVENT_NAME: "",
        SOURCE_REPOSITORY: repo,
        SOURCE_BASE_SHA: values.base ?? process.env.SOURCE_BASE_SHA ?? "",
        GITHUB_OUTPUT: "",
      },
    });
    if (checked.error || checked.status !== 0)
      throw Error(
        "DEVELOPMENT_PREFLIGHT_FAILED: " +
          (checked.error?.message || checked.stderr || checked.stdout),
      );
    return checked.stdout;
  };
  const source = JSON.parse(
    invoke(join(path, "scripts/source-quality.mjs"), ["--phase", "plan", "--working-tree"]),
  );
  const knowledgeConfig = join(
    path,
    repo === "dsh-agent-workbench" ? "agent-knowledge.json" : "docs/agent-knowledge.json",
  );
  const knowledgeInput = manifest.scripts?.["check:knowledge"] ? json(knowledgeConfig) : null;
  const missingKnowledgeInputs = [
    ...new Set(Object.values(knowledgeInput?.commandRoots ?? {}).flat()),
  ]
    .map((directory) => resolve(path, directory, "package.json"))
    .filter((file) => !fs.existsSync(file));
  const knowledge = !knowledgeInput
    ? { status: "not-applicable" }
    : missingKnowledgeInputs.length
      ? {
          status: "deferred",
          reason: "configured knowledge command roots are unavailable",
          missingInputs: missingKnowledgeInputs,
          command: "check:knowledge",
        }
      : knowledgeInput.exports
        ? {
            status: "deferred",
            reason: "configured package export checks require compiled outputs",
            command: "check:knowledge",
          }
        : { status: "planned", command: "check:knowledge" };
  if (action === "plan") {
    const impact =
      source.mode === "code"
        ? JSON.parse(
            invoke(join(path, "scripts/source-quality.mjs"), [
              "--phase",
              "affected-plan",
              "--working-tree",
            ]),
          )
        : { status: "not-applicable", reason: "cold " + source.mode + " lane", files: [] };
    return { status: "planned", repo, scope: "local-working-tree", source, knowledge, impact };
  }
  invoke(join(path, "scripts/source-quality.mjs"), ["--phase", "check", "--working-tree"]);
  if (knowledge.status === "planned") {
    const workbench =
      repo === "dsh-agent-workbench" ? path : resolve(path, "../dsh-agent-workbench");
    invoke(join(workbench, "scripts/check-agent-knowledge.mjs"), [
      "--root",
      path,
      "--config",
      knowledgeConfig,
    ]);
    knowledge.status = "passed";
  }
  return {
    status: "passed",
    repo,
    scope: "local-working-tree",
    source,
    knowledge,
    checks: {
      resources: source.mode === "docs" ? "not-applicable" : "passed",
      engineeringSyntax: source.mode === "code" ? "passed" : "not-applicable",
      workflowSemantics: source.workflows ? "passed" : "not-applicable",
    },
  };
}

export async function developmentTask(action, values = {}, cwd = process.cwd()) {
  if (["preflight", "plan"].includes(action)) return localSourceTask(action, values, cwd);
  const owner = repository(cwd);
  if (action === "check") return { status: "checked", repo: owner.repo, ...dependencyInput(owner) };
  if (action === "prepare") return prepareDependencies(owner);
  if (action === "build") return build(owner, values.target ?? "plugin");
  if (action === "typecheck") {
    const [file, args] = command(
      owner,
      owner.manifest.scripts["typecheck:official"] ? "typecheck:official" : "typecheck",
    );
    run(file, args, owner.path);
    return { status: "passed" };
  }
  if (action === "verify") {
    if (!values.input || !values.sha256) throw Error("DEVELOPMENT_FROZEN_INPUT_REQUIRED");
    const [file, args] = command(owner, "quality:ci");
    run(
      file,
      [
        ...args,
        ...(owner.manager === "npm" ? ["--"] : []),
        "--input",
        resolve(values.input),
        "--final-group-sha256",
        values.sha256,
      ],
      owner.path,
    );
    return { status: "passed" };
  }
  if (action === "finish" || action === "report") {
    const root = join(owner.path, ".runtime/development");
    const receipts = fs.existsSync(root)
      ? fs
          .readdirSync(root)
          .filter((file) => /^(?:dependencies|build-.+)\.json$/.test(file))
          .map((file) => {
            const record = json(join(root, file));
            return {
              receipt: join(root, file),
              owner: record.owner,
              sourceHead: record.sourceHead,
              purpose: record.purpose,
              retention: record.retention,
              paths: (record.generated ?? ["node_modules"]).map((path) => join(owner.path, path)),
            };
          })
      : [];
    const validationRoot = join(owner.path, ".runtime/plugin-split-validation");
    const validations = fs.existsSync(validationRoot)
      ? fs
          .readdirSync(validationRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => {
            const path = join(validationRoot, entry.name);
            const lifecycle = join(path, "lifecycle.json");
            return {
              path,
              lifecycle: fs.existsSync(lifecycle) ? json(lifecycle) : null,
              exited: fs.existsSync(join(path, "exit.json")),
              retention: "protected-user-data-and-evidence",
            };
          })
      : [];
    return {
      status: "report-only",
      ...(values.outputs ? { outputDisposition: checkDevelopmentOutputs(values.outputs) } : {}),
      receipts,
      validations,
      admissions: readBuildAdmissions(owner.path),
      retain: ["source", "user-data", "sessions", "credentials", "failure-evidence"],
      retirement:
        "Use the existing reviewed cleanup plan after checking readers, task inputs and open files.",
    };
  }
  throw Error("DEVELOPMENT_ACTION_UNKNOWN");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    options: {
      target: { type: "string" },
      input: { type: "string" },
      sha256: { type: "string" },
      base: { type: "string" },
      outputs: { type: "string" },
    },
    allowPositionals: true,
  });
  try {
    const result = await developmentTask(positionals[0], values);
    console.log(JSON.stringify(result));
    if (positionals[0] === "finish" && result.outputDisposition?.status === "needs-disposition")
      process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error.message,
        availableBytes: error.availableBytes,
        requiredBytes: error.requiredBytes,
      }),
    );
    process.exitCode = 1;
  }
}
