/** Small filesystem source combinations use the current core and the real release-history policy. */
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readSourceUpdateBaseline } from "../../scripts/source-update.mjs";
import { selectSourceCombination } from "../../scripts/source-profile.mjs";

const project = resolve(import.meta.dirname, "../../../../..");
export const core = resolve(project, ".parallel/ticket-09/deepseek-harness");
export const releases = await import(
  pathToFileURL(
    resolve(project, "dsh-plugin-hub/src/server/services/release-channel.ts"),
  )
);
export const gea = "@cleverc2200/gea-dsh-prototype",
  workbench = "@cleverc2200/dsh-agent-workbench",
  manage = "dsh-agent-manage";
export const names = [
  gea,
  workbench,
  manage,
  "dsh-plugin",
  "@changfenhuang/dsh-genui",
  "dsh-better-sidebar",
];
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

async function hashes(directory, prefix = "") {
  const result = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const key = prefix ? prefix + "/" + entry.name : entry.name,
      file = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(file, key));
    else if (entry.isSymbolicLink())
      result[key] = "link:" + (await fs.realpath(file));
    else if (entry.name !== "combination.json")
      result[key] = digest(await fs.readFile(file));
  }
  return result;
}

export async function sourceUpdateFixture(t) {
  const runtime = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "current-source-updates-")),
  );
  t.after(() => fs.rm(runtime, { recursive: true, force: true }));
  const channel = join(runtime, "channel");
  await fs.mkdir(channel);
  const source = join(runtime, "source");
  await fs.mkdir(source);
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", [
    "-C",
    source,
    "remote",
    "add",
    "source",
    "https://example.invalid/current-source.git",
  ]);
  const coreSha = execFileSync("git", ["-C", core, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const snapshot = async (changes = {}, { originDirectory = source } = {}) => {
    const id = randomUUID(),
      dir = join(runtime, "source-combinations", id),
      plugins = {},
      dependencies = {};
    for (const name of names) {
      const { version = "1.0.0", label = name } = changes[name] ?? {};
      const target = join(dir, "node_modules", name);
      await fs.mkdir(join(target, "lib"), { recursive: true });
      await fs.writeFile(
        join(target, "package.json"),
        JSON.stringify({
          name,
          version,
          type: "module",
          main: "lib/host.js",
          exports: {
            ".": "./lib/host.js",
            "./client": "./lib/client.js",
            "./package.json": "./package.json",
          },
        }),
      );
      await fs.writeFile(
        join(target, "lib/host.js"),
        "export default " + JSON.stringify({ name, version, label }) + ";\n",
      );
      await fs.writeFile(
        join(target, "lib/client.js"),
        "// fixture client " + label,
      );
      dependencies[name] = version;
      plugins[name] = {
        source: originDirectory,
        version,
        commit: "a".repeat(40),
        dirty: "",
        digests: {},
      };
    }
    const geaRoot = join(dir, "node_modules", gea);
    await fs.mkdir(join(geaRoot, "presets/gea-readonly"), { recursive: true });
    await fs.writeFile(
      join(geaRoot, "presets/gea-readonly/agent.cordis.yml"),
      await fs.readFile(
        resolve(
          project,
          "dsh-gea-plugin/presets/gea-readonly/agent.cordis.yml",
        ),
      ),
    );
    await fs.writeFile(
      join(geaRoot, "lib/skill-reference.js"),
      "export default {};",
    );
    for (const name of names)
      for (const dependency of names) {
        const link = join(
          dir,
          "node_modules",
          name,
          "node_modules",
          dependency,
        );
        await fs.mkdir(resolve(link, ".."), { recursive: true });
        await fs.symlink(join(dir, "node_modules", dependency), link);
      }
    const patches = [
      join(dir, "deployment.patch.json"),
      join(dir, "presets.patch.yml"),
    ];
    await fs.writeFile(
      patches[0],
      JSON.stringify([{ id: "gea-proof", name: join(geaRoot, "lib/host.js") }]),
    );
    await fs.writeFile(patches[1], "[]\n");
    await fs.writeFile(
      join(dir, "company-plugins.json"),
      JSON.stringify(plugins),
    );
    await fs.writeFile(
      join(dir, "combination.json"),
      JSON.stringify({
        composition: {
          id,
          dependencies,
          bundles: [gea, manage, "dsh-plugin"],
          patches,
        },
        core: coreSha,
        files: await hashes(dir),
        externalFiles: Object.fromEntries(
          Object.entries(await hashes(join(core, "apps/web/dist"))).map(
            ([file, hash]) => [join(core, "apps/web/dist", file), hash],
          ),
        ),
        externalRoots: [join(core, "apps/web/dist")],
        externalLockFiles: [],
        locks: { core: {} },
      }),
    );
    return id;
  };
  const initial = await snapshot();
  await selectSourceCombination(runtime, initial, core);
  await fs.mkdir(join(runtime, "workspace"));
  await fs.writeFile(join(runtime, "workspace/user.txt"), "keep user data");
  const baseline = await readSourceUpdateBaseline(runtime, core);
  const proposal = async (combination, components, previous = baseline) => {
    const entries = [];
    // Only reading a staged identity: no selection is changed to derive its metadata.
    const record = JSON.parse(
      await fs.readFile(
        join(runtime, "source-combinations", combination, "combination.json"),
        "utf8",
      ),
    );
    const plugins = JSON.parse(
      await fs.readFile(
        join(
          runtime,
          "source-combinations",
          combination,
          "company-plugins.json",
        ),
        "utf8",
      ),
    );
    const { sourceComponent } = await import(
      "../../scripts/source-profile.mjs"
    );
    for (const name of components) {
      const actual = sourceComponent(record, plugins, name),
        artifact = join(channel, randomUUID() + ".json");
      const bytes = Buffer.from(JSON.stringify({ combination, package: name }));
      await fs.writeFile(artifact, bytes);
      entries.push({
        package: name,
        version: actual.version,
        sha256: actual.sha256,
        source: actual.source,
        downloadSha256: digest(bytes),
        url: pathToFileURL(artifact).href,
        compatible: {
          core: [coreSha],
          interface: "current-unified-v2",
          workbench: ["1.0.0", "1.1.0", "1.2.0"],
        },
      });
    }
    const value = {
      kind: "current-source-update-v1",
      source: pathToFileURL(join(channel, "catalog.json")).href,
      baseline: previous,
      releases: entries,
    };
    await fs.writeFile(join(channel, "catalog.json"), JSON.stringify(value));
    return value;
  };
  return { runtime, snapshot, proposal, baseline, initial, channel };
}
