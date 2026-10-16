import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { readPluginUpdateCore } from "../src/host/plugin-update-core.ts";
import { createPluginReleaseSource } from "../src/host/plugin-release-source.ts";

export function planOfficialUpdateConfiguration(rows, deployment) {
  const matches = rows.flatMap((row, index) =>
    row.name === "@cleverc2200/gea-dsh-prototype" ? [index] : [],
  );
  if (matches.length !== 1) throw Error("GEA_CONFIG_NOT_UNIQUE");
  const index = matches[0],
    previous = rows[index].config?.pluginUpdates;
  if (!previous || !isDeepStrictEqual(previous.source, deployment.source))
    throw Error("UPDATE_SOURCE_CHANGED");
  if (
    previous.core.version !== deployment.core.version ||
    !deployment.previousHeads.includes(previous.core.head)
  )
    throw Error("UNEXPECTED_PREVIOUS_CORE");
  const updates = { ...previous, core: deployment.core };
  const expected = structuredClone(rows);
  expected[index].config.pluginUpdates = updates;
  return { index, updates, expected, changed: !isDeepStrictEqual(previous, updates) };
}

export async function configureOfficialUpdates({ profile, deployment }) {
  const root = deployment.core.root;
  const appRoot = root.slice(0, -"/Contents/Resources/app.asar".length);
  if (process.platform !== "darwin" || !process.execPath.startsWith(appRoot + "/Contents/MacOS/"))
    throw Error("USE_THE_TARGET_APP_NODE");
  const running = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" })
    .split("\n")
    .some((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return (
        match &&
        Number(match[1]) !== process.pid &&
        /\/(?:DeepSeek Harness|GEA Desktop)\.app\/Contents\/MacOS\/(?:DeepSeek Harness|GEA Desktop)$/.test(
          match[2],
        )
      );
    });
  if (running) throw Error("QUIT_DSH_FIRST");
  const require = createRequire(join(profile, "package.json"));
  const YAML = require("yaml");
  for (const [name, allowed] of Object.entries(deployment.installedVersions)) {
    const manifest = JSON.parse(
      await readFile(join(profile, "node_modules", name, "package.json"), "utf8"),
    );
    if (!allowed.includes(manifest.version)) throw Error("CLIENT_VERSION_MISMATCH: " + name);
  }
  const sdk = join(root, "dsh/node_modules/@deepseek-ai");
  const { Context } = await import(pathToFileURL(join(sdk, "cordis/lib/index.js")));
  const { PluginPackages } = await import(pathToFileURL(join(sdk, "dsh-app-boot/lib/index.js")));
  const context = new Context();
  try {
    await context.plugin(PluginPackages);
    await readPluginUpdateCore(
      {
        profileContext: {
          installAnchor: join(root, "dsh/node_modules/@deepseek-ai/dsh/package.json"),
        },
        fiber: {
          entry: {
            parent: {
              tree: { ctx: { baseUrl: pathToFileURL(join(root, "dsh/package.json")).href } },
            },
          },
        },
        get: (name) => context.get(name),
      },
      deployment.core,
    );
  } finally {
    await context.fiber.dispose();
  }
  const { withFileLock } = await import(pathToFileURL(join(sdk, "dsh-atomic-write/lib/index.js")));
  return withFileLock(join(profile, "package.json"), async () => {
    const configPath = join(profile, "cordis.patch.yml"),
      before = await readFile(configPath);
    const document = YAML.parseDocument(before.toString());
    if (document.errors.length) throw Error("PROFILE_YAML_INVALID");
    const plan = planOfficialUpdateConfiguration(document.toJS(), deployment);
    if (!plan.changed) return { status: "already-configured", changed: false };
    const updateRoot = join(profile, "gea/plugin-updates");
    const latestPath = join(updateRoot, "latest.json"),
      latest = await readFile(latestPath);
    const operationPath = join(updateRoot, "operations", JSON.parse(latest).id, "receipt.json");
    const operation = await readFile(operationPath);
    if (!["completed", "restored", "failed"].includes(JSON.parse(operation).stage))
      throw Error("UPDATE_OPERATION_IN_PROGRESS");
    const backup = join(
      updateRoot,
      "core-switches",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of [
      ["cordis.patch.yml", before],
      ["latest.json", latest],
      ["operation.json", operation],
    ])
      await writeFile(join(backup, name), bytes, { mode: 0o600, flag: "wx" });
    const trust = await readFile(join(updateRoot, "source-trust/approved-channel.json"));
    await writeFile(join(backup, "approved-channel.json"), trust, { mode: 0o600, flag: "wx" });
    const source = createPluginReleaseSource(deployment.source, {
      resolveAuthentication: async () => ({}),
      trustDirectory: join(backup, "validated-source"),
    });
    const releases = await source.check();
    const target = releases.find((row) => row.name === "@cleverc2200/gea-dsh-prototype");
    if (
      !target ||
      target.version !== deployment.release.version ||
      target.artifact.sha256 !== deployment.release.sha256 ||
      !target.supportedCores.some(
        (core) => core.head === deployment.core.head && core.version === deployment.core.version,
      )
    )
      throw Error("PUBLISHED_RELEASE_MISMATCH");
    document.setIn([plan.index, "config", "pluginUpdates"], plan.updates);
    const after = Buffer.from(document.toString());
    if (!isDeepStrictEqual(YAML.parse(after.toString()), plan.expected))
      throw Error("UNRELATED_CONFIG_CHANGED");
    if (!(await readFile(configPath)).equals(before)) throw Error("PROFILE_CHANGED");
    await writeFile(configPath + ".core-switch", after, {
      flag: "wx",
      mode: (await stat(configPath)).mode & 0o777,
    });
    await rename(configPath + ".core-switch", configPath);
    if (
      !(await readFile(latestPath)).equals(latest) ||
      !(await readFile(operationPath)).equals(operation) ||
      !(await readFile(join(updateRoot, "source-trust/approved-channel.json"))).equals(trust)
    )
      throw Error("UPDATE_RECEIPT_CHANGED");
    const receipt = {
      status: "configured",
      backup,
      operationId: JSON.parse(latest).id,
      originalReceiptsPreserved: true,
      head: deployment.core.head,
      version: deployment.core.version,
    };
    await writeFile(join(backup, "result.json"), JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    return receipt;
  });
}
