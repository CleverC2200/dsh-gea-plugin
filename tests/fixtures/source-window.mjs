/** Disposable source checkouts and a process observer; the fixed Core is read-only. */
import { readFile, writeFile, mkdir, cp, symlink, mkdtemp, rm, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readDeployment } from "../../scripts/deployment.mjs";
import { sourcePlugins } from "../../scripts/source-composition.mjs";
import { readSourceWindowInputs } from "./source-window-inputs.mjs";
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const objectHash = (value) => hash(JSON.stringify(value));
const sourceRoot = resolve(import.meta.dirname, "../..");
const save = (file, value) => writeFile(file, JSON.stringify(value));
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export async function sourceWindow(t, mode, { inputFile } = {}) {
  const {
    core: fixedCore,
    workbench: sharedWB,
    manage: sharedManage,
    candidateOwners,
    historicalFailure,
  } = await readSourceWindowInputs(inputFile);
  const temporary = await mkdtemp(join(tmpdir(), "source-window-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const group = join(temporary, "implement"),
    own = join(group, "05");
  await mkdir(own, { recursive: true });
  await symlink(fixedCore, join(group, "official-latest-standard"));
  const repositories = [];
  for (const repo of sourcePlugins.map((plugin) => plugin.repo)) {
    const root = join(own, repo);
    await mkdir(root);
    await save(join(root, "package.json"), {
      name: sourcePlugins.find((p) => p.repo === repo).name,
      version: "1.0.0",
      type: "module",
    });
    await writeFile(
      join(root, repo === "dsh-agent-workbench" ? "package-lock.json" : "pnpm-lock.yaml"),
      "fixture-lock",
    );
    await writeFile(join(root, ".gitignore"), ".runtime/\nnode_modules/\nlib/\n");
    await mkdir(join(root, "scripts"));
    if (repo === "dsh-agent-workbench") {
      for (const name of [
        "verify-candidate-input.mjs",
        "candidate-input.mjs",
        "verify-official-input.mjs",
      ])
        await cp(join(sharedWB, "scripts", name), join(root, "scripts", name));
      const original = JSON.parse(await readFile(join(sharedWB, "tsconfig.official.json"), "utf8"));
      const cordis = resolve(sharedWB, original.compilerOptions.paths["@deepseek-ai/cordis"][0]);
      await save(join(root, "tsconfig.official.json"), {
        compilerOptions: { paths: { "@deepseek-ai/cordis": [cordis] } },
      });
    }
    if (repo === "dsh-agent-manage")
      for (const name of ["prepare-official-sdk.mjs", "sdk-artifact-cache.mjs"])
        await cp(join(sharedManage, "scripts", name), join(root, "scripts", name));
    if (repo === "dsh-gea-plugin") {
      for (const name of [
        "start.mjs",
        "start-isolated-validation.mjs",
        "window-admission.mjs",
        "source-profile.mjs",
        "source-composition.mjs",
        "source-combination-integrity.mjs",
        "deployment.mjs",
        "current-core.json",
        "supported-cores.mjs",
        "supported-cores.json",
      ])
        await cp(join(sourceRoot, "scripts", name), join(root, "scripts", name));
      await mkdir(join(root, "tests"));
      await cp(
        join(sourceRoot, "tests/source-profile-start.mjs"),
        join(root, "tests/source-profile-start.mjs"),
      );
      await mkdir(join(root, "src"));
      await cp(join(sourceRoot, "src/shared"), join(root, "src/shared"), {
        recursive: true,
      });
    }
    git(root, "init", "-q");
    git(root, "remote", "add", "source", "https://fixture.invalid/" + repo);
    git(root, "add", ".");
    git(
      root,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@invalid.test",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "disposable input",
    );
    repositories.push({
      repo,
      path: root,
      head: git(root, "rev-parse", "HEAD"),
    });
  }
  const gea = repositories.find((p) => p.repo === "dsh-gea-plugin").path;
  const candidateFile = join(temporary, "candidate.json");
  const coreSha = git(fixedCore, "rev-parse", "HEAD");
  await save(candidateFile, {
    core: coreSha,
    repositories: repositories.filter(({ repo }) => candidateOwners.includes(repo)),
  });
  const configFile = join(temporary, "deployment.json");
  await save(configFile, {
    geaBaseUrl: "https://127.0.0.1:1/gea-boot",
    pageSize: 10,
    periodPageSize: 100,
    requestTimeoutMs: 15000,
    maxSnapshotBytes: 100000,
    analysis: { mode: "receipt" },
    sqlReadLimit: {
      consumerCode: "fixture-reader",
      maxRequests: 0,
      maxPagesPerQuery: 1,
      maxRowsPerQuery: 1,
    },
  });
  const deployment = await readDeployment(configFile);
  const runtime =
    mode === "source-host"
      ? join(temporary, "runtime")
      : join(gea, ".runtime/plugin-split-validation");
  let combination = { kind: "core" },
    sourcesFile;
  if (mode !== "isolated-core-host") {
    const id = randomUUID(),
      preparedRuntime = mode === "isolated-source-host" ? join(temporary, "prepared") : runtime,
      directory = join(preparedRuntime, "source-combinations", id);
    await mkdir(directory, { recursive: true });
    const dependencies = {},
      plugins = {},
      files = {};
    for (const plugin of sourcePlugins) {
      const owner = repositories.find((repo) => repo.repo === plugin.repo);
      dependencies[plugin.name] = "1.0.0";
      plugins[plugin.name] = {
        version: "1.0.0",
        source: owner.path,
        commit: owner.head,
      };
      const file = `node_modules/${plugin.name}/package.json`;
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await save(join(directory, file), {
        name: plugin.name,
        version: "1.0.0",
      });
      files[file] = hash(await readFile(join(directory, file)));
      const assets = join(directory, "node_modules", plugin.name);
      await mkdir(join(assets, "lib"), { recursive: true });
      await mkdir(join(assets, "client"), { recursive: true });
      await mkdir(join(assets, "node_modules"));
      await writeFile(join(assets, "lib/host.js"), "export {};");
      await writeFile(join(assets, "client/client.js"), "export {};");
      await writeFile(join(assets, "cordis.patch.yml"), "[]");
      for (const extra of plugin.digests) {
        await mkdir(dirname(join(assets, extra)), { recursive: true });
        await writeFile(join(assets, extra), "fixture");
      }
      if (plugin.repo === "dsh-gea-plugin") {
        await mkdir(join(assets, "scripts"));
        await cp(
          join(sourceRoot, "scripts/deployment.mjs"),
          join(assets, "scripts/deployment.mjs"),
        );
        await mkdir(join(assets, "src"));
        await cp(join(sourceRoot, "src/shared"), join(assets, "src/shared"), {
          recursive: true,
        });
      }
    }
    await save(join(directory, "company-plugins.json"), plugins);
    files["company-plugins.json"] = hash(await readFile(join(directory, "company-plugins.json")));
    Object.assign(files, await assetFiles(directory));
    await save(join(directory, "combination.json"), {
      core: coreSha,
      composition: { id, dependencies, bundles: [], patches: [] },
      files,
      externalFiles: {},
      externalRoots: [],
      externalLockFiles: [],
    });
    const manifestSha256 = hash(await readFile(join(directory, "combination.json")));
    if (mode === "isolated-source-host") {
      const inputs = [];
      for (const plugin of sourcePlugins) {
        const owner = repositories.find((owner) => owner.repo === plugin.repo),
          assets = join(directory, "node_modules", plugin.name);
        inputs.push({
          repo: plugin.repo,
          source: owner.path,
          commit: owner.head,
          assets,
          dependencies: join(assets, "node_modules"),
          files: await assetFiles(assets, true),
        });
      }
      sourcesFile = join(temporary, "frozen-sources.json");
      await save(sourcesFile, inputs);
      combination = {
        kind: "sources",
        file: sourcesFile,
        sha256: hash(await readFile(sourcesFile)),
        snapshot: { runtime: preparedRuntime, id, manifestSha256 },
      };
    } else {
      await save(join(runtime, "source-selection.json"), {
        id,
        manifestSha256,
      });
      combination = { kind: "selection", id, manifestSha256 };
    }
  }
  const budget = {
    limits: {
      hostStarts: 1,
      businessRequests: 0,
      modelTasks: 0,
      businessWrites: 0,
    },
    remaining: {
      hostStarts: 1,
      businessRequests: 0,
      modelTasks: 0,
      businessWrites: 0,
    },
  };
  const freezeFile = join(temporary, "frozen-current-window.json");
  const frozen = {
    file: "frozen-current-window.json",
    case: "current-fixture",
    owner: "fixture-owner",
    mode,
    core: fixedCore,
    runtime,
    candidate: {
      file: candidateFile,
      sha256: hash(await readFile(candidateFile)),
    },
    combination,
    ...(mode === "source-host"
      ? {
          config: {
            file: configFile,
            sha256: hash(await readFile(configFile)),
          },
          deploymentSha256: objectHash(deployment),
        }
      : {}),
    budget,
  };
  const windowFile = join(temporary, "window.json");
  const current = {
    case: frozen.case,
    owner: frozen.owner,
    status: "open",
    paused: false,
    freeze: { file: freezeFile },
    budget: structuredClone(budget),
  };
  const request = {
    file: windowFile,
    case: frozen.case,
    owner: frozen.owner,
    freezeSha256: "",
  };
  const refresh = async () => {
    await save(freezeFile, frozen);
    request.freezeSha256 = hash(await readFile(freezeFile));
    await save(windowFile, current);
  };
  await refresh();
  const fixture = join(temporary, "loopback-host.mjs");
  await writeFile(
    fixture,
    `import http from 'node:http'; const server=http.createServer((q,s)=>s.end('fixture')); await new Promise(r=>server.listen(0,'127.0.0.1',r)); const response=await fetch('http://127.0.0.1:'+server.address().port); if(await response.text()!=='fixture')throw Error('loopback fixture failed'); server.close(); console.log('LOCAL_LOOPBACK_FIXTURE_ONLY');`,
  );
  const probe = join(temporary, "observe-process.mjs"),
    observation = join(temporary, "effects.json");
  await writeFile(
    probe,
    `import fs from 'node:fs'; import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; const original=child.spawn; const save=fs.writeFileSync; const writes=[]; const processes=[]; const network=[]; const credentialReads=[]; const credentialEnvReads=[]; const env=process.env; process.env=new Proxy(env,{get(target,key){if(key==="GEA_FIXTURE_DIRECT_KEY")credentialEnvReads.push(key);return Reflect.get(target,key);}}); const execute=child.execFileSync; child.execFileSync=function(command,args,...rest){if(String(command).includes("security")){credentialReads.push({command,args});throw Error("UNEXPECTED_KEYCHAIN_READ");}return execute.call(this,command,args,...rest);}; const keys=['DSH_HOME','DSH_TELEMETRY_DISABLED','GEA_WEB_LOGIN_PERSIST','GEA_HTML_PLUGIN_ROOTS','GEA_FIXTURE_ID','GEA_FIXTURE_SECRET']; const before=Object.fromEntries(keys.map(k=>[k,process.env[k]??null])); for(const key of ['mkdir','mkdtemp','writeFile','rename','symlink','unlink','open']){const fn=fs.promises[key]; fs.promises[key]=function(...args){if(key!=='open'||/[wax+]/.test(args[1]))writes.push({operation:key,path:String(args[0])});return fn.apply(this,args);};} child.spawn=function(command,args,options){processes.push({command,args,cwd:options.cwd});return original(process.execPath,[${JSON.stringify(fixture)}],{...options,detached:false});}; globalThis.fetch=(...args)=>{network.push(String(args[0]));throw Error('UNEXPECTED_NETWORK');}; syncBuiltinESMExports(); process.on('exit',()=>save(${JSON.stringify(observation)},JSON.stringify({writes,processes,network,credentialReads,credentialEnvReads,before,after:Object.fromEntries(keys.map(k=>[k,process.env[k]??null]))})));`,
  );
  const run = (entry = "start.mjs", extra = [], environment = {}) => {
    let args;
    if (entry === "runSourceProfile") {
      const runner = join(temporary, "call-profile.mjs");
      // The runner uses only the existing public function; admission has no test-only interface.
      fsWrite(
        runner,
        `import {runSourceProfile} from ${JSON.stringify(pathToFileURL(join(gea, "scripts/start-isolated-validation.mjs")).href)}; await runSourceProfile(${JSON.stringify(fixedCore)},${JSON.stringify(runtime)},${mode !== "isolated-core-host"},${mode === "source-host" ? JSON.stringify(deployment) : "undefined"},0,${JSON.stringify({ window: request, mode, ...extra })});`,
      );
      args = [runner];
    } else {
      args = [
        join(gea, "scripts", entry),
        "--window",
        request.file,
        "--case",
        request.case,
        "--owner",
        request.owner,
        "--freeze-sha256",
        request.freezeSha256,
      ];
      if (entry === "start.mjs")
        args.push("--config", configFile, "--runtime", runtime, "--port", "0");
      else {
        args.push("--core", fixedCore);
        if (mode === "isolated-source-host") args.push("--plugins", "--sources", sourcesFile);
      }
      args.push(...extra);
    }
    return spawnSync(process.execPath, ["--import", probe, ...args], {
      encoding: "utf8",
      timeout: 20000,
      env: { PATH: process.env.PATH, HOME: temporary, ...environment },
    });
  };
  return {
    temporary,
    historicalFailure,
    gea,
    fixedCore,
    candidateFile,
    configFile,
    sourcesFile,
    runtime,
    frozen,
    current,
    request,
    refresh,
    run,
    observation,
  };
}
import { writeFileSync as fsWrite } from "node:fs";
export async function snapshot(directory) {
  const result = {};
  async function visit(path, prefix = "") {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const key = prefix + entry.name,
        file = join(path, entry.name);
      if (entry.isDirectory()) {
        result[key + "/"] = "directory";
        await visit(file, key + "/");
      } else if (entry.isFile()) result[key] = hash(await readFile(file));
    }
  }
  await visit(directory);
  return result;
}

async function assetFiles(directory, excludeDependencies = false) {
  const files = {};
  async function walk(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (
        (excludeDependencies && entry.name === "node_modules") ||
        entry.name === "combination.json"
      )
        continue;
      const key = prefix + entry.name,
        file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file, key + "/");
      else if (entry.isFile()) files[key] = hash(await readFile(file));
    }
  }
  await walk(directory);
  return files;
}
