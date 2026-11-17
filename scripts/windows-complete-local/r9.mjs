import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  buildR9Bundle,
  uploadR9Bundle,
  collectR9Evidence,
  verifyR9Evidence,
} from "./r9/evidence.mjs";

const [command, ...args] = process.argv.slice(2);
const { values } = parseArgs({
  args,
  options: {
    output: { type: "string" },
    input: { type: "string" },
    run: { type: "string" },
    head: { type: "string" },
    bundle: { type: "string" },
    upload: { type: "boolean", default: false },
  },
});
let result;
if (command === "bundle" && values.output) {
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--", "scripts/windows-complete-local/r9"],
    { cwd, encoding: "utf8" },
  );
  if (dirty.trim()) throw Error("R9_CLEAN_DRIVER_REQUIRED");
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  result = await buildR9Bundle(resolve(values.output), sourceSha);
  if (values.upload) result = await uploadR9Bundle(resolve(values.output));
} else if (command === "collect" && values.run && values.head && values.bundle && values.output) {
  result = await collectR9Evidence({
    runId: values.run,
    expectedHead: values.head,
    bundleFile: resolve(values.bundle),
    output: resolve(values.output),
  });
} else if (command === "verify" && values.input && !values.output && !values.upload) {
  result = await verifyR9Evidence(resolve(values.input));
} else {
  throw Error(
    "R9_COMMAND_REQUIRED: bundle --output NEW_DIRECTORY [--upload] | collect --run ID --head SHA --bundle bundle.json --output NEW_DIRECTORY | verify --input CAPTURE_DIRECTORY",
  );
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
