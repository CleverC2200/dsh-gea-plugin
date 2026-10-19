import { spawnSync } from "node:child_process";
import { resolve, join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readSupportedCore } from "./supported-cores.mjs";
import { resolveBuiltinPlugins } from "./deployment.mjs";

const entries = [
  "packages/boot/app-boot/lib/index.js",
  "packages/boot/plugin-manager/lib/types/operations.js",
  "apps/cli/lib/profile-boot.js",
];
const probe = String.raw`
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const {core,entries}=JSON.parse(process.argv[1]);
let result={ready:true,entries};
for(const entry of entries){
  try{await import(pathToFileURL(join(core,entry)).href);}
  catch(error){
    const dependency=error.message?.match(/Cannot find (?:package|module) ['"](@?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)['"]/)?.[1];
    result={ready:false,entry,code:/^[A-Z_]+$/.test(error.code??'')?error.code:'IMPORT_FAILED',...(dependency?{dependency}:{})};
    break;
  }
}
process.stdout.write('RUNTIME_ENVIRONMENT_RESULT='+JSON.stringify(result)+'\n');
process.exitCode=result.ready?0:1;
`;

export function verifyRuntimeModules({ core, consumer }) {
  if (!isAbsolute(core)) throw Error("RUNTIME_CORE_ABSOLUTE_REQUIRED");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", probe, JSON.stringify({ core, entries })],
    {
      cwd: core,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DSH_TELEMETRY_DISABLED: "1" },
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
    },
  );
  const line = child.stdout
    ?.split("\n")
    .find((value) => value.startsWith("RUNTIME_ENVIRONMENT_RESULT="));
  const result = line ? JSON.parse(line.slice("RUNTIME_ENVIRONMENT_RESULT=".length)) : undefined;
  if (child.error || child.status !== 0 || result?.ready !== true) {
    const detail = result?.entry
      ? ` ${result.entry} ${result.code}${result.dependency ? ` ${result.dependency}` : ""}`
      : " probe did not complete";
    throw Error(
      `RUNTIME_CORE_NOT_READY:${detail}; prepare an owned checkout of the selected Core with dsh-agent-manage/scripts/prepare-official-sdk.mjs --prepare, then rerun check:environment`,
    );
  }
  if (consumer) {
    try {
      resolveBuiltinPlugins(pathToFileURL(join(consumer, "package.json")));
    } catch {
      throw Error(
        "RUNTIME_COMPANIONS_NOT_READY: prepare the declared GenUI and Sidebar inputs with quality:upstreams and the frozen consumer install, then rerun check:environment --purpose source",
      );
    }
  }
  return { status: "ready", core, entries: result.entries, companions: Boolean(consumer) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { core: { type: "string" }, purpose: { type: "string" } },
  });
  if (!isAbsolute(values.core ?? "") || !["reception", "source"].includes(values.purpose))
    throw Error(
      "RUNTIME_ENVIRONMENT_INPUT_REQUIRED: check:environment --core /absolute/fixed/core --purpose reception|source",
    );
  await readSupportedCore(values.core);
  console.log(
    JSON.stringify(
      verifyRuntimeModules({
        core: values.core,
        ...(values.purpose === "source" ? { consumer: resolve(import.meta.dirname, "..") } : {}),
      }),
    ),
  );
}
