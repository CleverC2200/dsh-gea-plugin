import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
export async function loadBusinessProfilePolicy(workbench) {
  if (!isAbsolute(workbench ?? "")) throw Error("BUSINESS_PROFILE_WORKBENCH_REQUIRED");
  const { createBusinessProfilePolicy } = await import(
    pathToFileURL(resolve(workbench, "scripts/ci-source-policy.mjs"))
  );
  return createBusinessProfilePolicy("dsh-gea-plugin");
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { values } = parseArgs({ options: { workbench: { type: "string" } } });
  const policy = await loadBusinessProfilePolicy(values.workbench);
  const { runBusinessProfileCli } = await import(
    pathToFileURL(resolve(values.workbench, "scripts/ci-source-policy.mjs"))
  );
  runBusinessProfileCli("dsh-gea-plugin", policy);
}
