import { readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { installArtifact } from "./installer.mjs";

export async function verifyCompanyManage(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (
    !manifest.dependencies?.["dsh-agent-manage"] ||
    manifest.dependencies?.["dsh-agent-plugins-market"]
  )
    throw Error("COMPANY_MCP_PLUGIN_REQUIRED");
  const require = createRequire(join(directory, "package.json"));
  const entry = require.resolve("dsh-agent-manage");
  await access(join(dirname(entry), "runtime/gea-mcp.js"));
  if (!(await readFile(entry, "utf8")).includes("mountGeaMcp"))
    throw Error("COMPANY_MCP_ENTRY_REQUIRED");
}

export async function installCompanyManage(options) {
  const path = join(options.directory, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  delete manifest.dependencies?.["dsh-agent-plugins-market"];
  delete manifest.overrides?.["dsh-agent-plugins-market"];
  if (manifest.dsh?.profile?.bundles)
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(
      (name) => name !== "dsh-agent-plugins-market",
    );
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
  await installArtifact(options);
  await verifyCompanyManage(options.directory);
}
