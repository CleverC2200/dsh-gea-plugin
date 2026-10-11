import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modelProfile } from "./model-profile.mjs";

// Literal declarations come from fixed registrations and resource headers, not model output.
const fixture = JSON.parse(
  await readFile(new URL("./catalog-scene-expectations.json", import.meta.url), "utf8"),
);
const packages = {
  workbench: "@cleverc2200/dsh-agent-workbench",
  manage: "dsh-agent-manage",
  genui: "@changfenhuang/dsh-genui",
  sidebar: "dsh-better-sidebar",
};
const repos = {
  workbench: "dsh-agent-workbench",
  manage: "dsh-agent-manage",
  genui: "dsh-genui",
  sidebar: "dsh-better-sidebar",
};
export const qaFixtureSkillNames = fixture.qaFixtureSkillNames;

async function hasPath(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

/** Keep all owner providers; only this scene's filesystem roots and native mode are fixed. */
export async function catalogSceneProfile(t, options, scene = "model") {
  assert.ok(["linux", "darwin"].includes(process.platform), "catalog scene requires bash platform");
  for (const name of ["GEA_HTML_PLUGIN_ROOTS", "GEA_HTML_LOCAL_QUERY_CONFIG", "DSH_PLUGIN_GRAPH"])
    assert.equal(
      process.env[name],
      undefined,
      `catalog scene requires a declared input for ${name}`,
    );
  assert.equal(options.beforeStart, undefined);
  const env = { ...options.env, DSH_TOOLS_MODE: "native", GEA_BROWSER_MCP: "0" };
  const app = await modelProfile(t, {
    ...options,
    env,
    async beforeStart({ runtime }) {
      // Fresh HOME prevents implicit personal layouts; all existing business providers remain.
      env.HOME = join(runtime, "catalog-user-home");
      env.DSH_AGENTS_HOME = join(runtime, "catalog-agents-home");
      env.DSH_BUNDLED_SKILL_DIR = join(runtime, "catalog-bundled-skills");
      const skill = join(runtime, "home/skills", fixture.canary.name);
      await Promise.all(
        [env.HOME, env.DSH_AGENTS_HOME, env.DSH_BUNDLED_SKILL_DIR, skill].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      // Core and Manage find the nearest .git ancestor. Reject an undeclared project;
      // do not disable their project discovery or silently assume its MCP catalog is empty.
      for (let current = runtime; ; current = dirname(current)) {
        assert.equal(
          await hasPath(join(current, ".git")),
          false,
          "undeclared catalog project root",
        );
        if (dirname(current) === current) break;
      }
      await writeFile(
        join(skill, "SKILL.md"),
        `---\nname: ${fixture.canary.name}\ndescription: ${fixture.canary.description}\n---\n${fixture.canary.body}\n`,
        { flag: "wx" },
      );
    },
  });
  const core = JSON.parse(await readFile(join(app.runtime, "core-source.json"), "utf8")).upstream;
  const tools = fixture.completeNativeTools[core];
  assert.ok(tools, "catalog scene requires an independently declared Core");
  const selected = JSON.parse(await readFile(join(app.runtime, "source-selection.json"), "utf8"));
  const combination = join(app.runtime, "source-combinations", selected.id);
  const owners = JSON.parse(await readFile(join(combination, "company-plugins.json"), "utf8"));
  for (const [owner, name] of Object.entries(packages))
    assert.equal(owners[name].commit, fixture.requiredPeers[repos[owner]], `${owner} scene input`);
  // Full source bytes bind the unchanged rules as well as independently frozen metadata.
  for (const source of fixture.provenance.metadataSources) {
    const file = source.file.replace(/^published@0\.11\.3\//, "");
    const bytes = await readFile(join(combination, "node_modules", packages[source.owner], file));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      source.sha256,
      `${source.owner} Skill source ${file}`,
    );
  }
  // With no inherited override, the existing launcher derives precisely these roots
  // from this selected combination, retaining Workbench's other built-in providers.
  const htmlRoots = ["inventory-fc", "inventory-aqkc"].map((id) =>
    join(combination, "node_modules", packages.workbench, "lib/business", id),
  );
  await writeFile(
    join(app.runtime, "catalog-scene-declaration.json"),
    JSON.stringify({
      scene,
      core,
      toolsMode: "native",
      htmlRoots,
      owners,
      filesystemRoots: {
        HOME: env.HOME,
        DSH_AGENTS_HOME: env.DSH_AGENTS_HOME,
        DSH_BUNDLED_SKILL_DIR: env.DSH_BUNDLED_SKILL_DIR,
      },
    }),
    { flag: "wx" },
  );
  app.catalogScene = {
    tools,
    entries: fixture.completeSkillEntries[scene],
    bodies: [fixture.canary.body, ...(scene === "promptQa" ? [fixture.qaFixtureSkillBody] : [])],
  };
  assert.ok(app.catalogScene.entries, "catalog scene metadata declaration required");
  return app;
}

/** Compare the complete catalog and metadata, and prove summaries did not load the body. */
export function assertCatalogScene(app, body, rows) {
  const names = body.tools.map((tool) => tool.function.name);
  assert.equal(new Set(names).size, names.length, "complete catalog has no duplicate names");
  assert.deepEqual(names.sort(), app.catalogScene.tools, "complete source-declared native catalog");
  const messages = rows.filter((row) => row.type === "user/message");
  const catalogs = messages.filter((row) => row.data.source.kind === "skill-catalog");
  assert.equal(catalogs.length, 1);
  assert.deepEqual(catalogs[0].data.source, {
    kind: "skill-catalog",
    form: "catalog",
    entries: app.catalogScene.entries,
  });
  assert.equal(
    messages.some((row) => row.data.source.kind === "skill-invocation"),
    false,
  );
  for (const skillBody of app.catalogScene.bodies) {
    assert.equal(JSON.stringify(rows).includes(skillBody), false);
    assert.equal(JSON.stringify(body.messages).includes(skillBody), false);
  }
  const calls = rows
    .filter((row) => row.type === "assistant/message")
    .flatMap((row) => row.data.message.content)
    .filter((block) => block.type === "tool-call");
  assert.equal(
    calls.some((call) => ["skill", "skill_reference_read"].includes(call.name)),
    false,
  );
}
