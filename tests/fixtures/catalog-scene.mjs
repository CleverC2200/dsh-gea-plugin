import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modelProfile } from "./model-profile.mjs";
import { fixtureCubeTools } from "./cube-wire.mjs";

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

/** Match assembled owners to the explicitly admitted candidate, retaining fixed fallback inputs. */
export async function assertCatalogSceneOwners(
  owners,
  { input, sha256 } = {
    input: process.env.GEA_TEST_CANDIDATE,
    sha256: process.env.GEA_TEST_CANDIDATE_SHA256,
  },
) {
  const peers = { ...fixture.requiredPeers };
  if (input !== undefined || sha256 !== undefined) {
    assert.ok(
      input && sha256?.length === 64 && /^[a-f0-9]{64}$/.test(sha256),
      "catalog candidate original hash required",
    );
    const bytes = await readFile(input);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      sha256,
      "catalog candidate original bytes",
    );
    const manifest = JSON.parse(bytes);
    const names = ["dsh-agent-workbench", "dsh-agent-manage", "dsh-gea-plugin"];
    assert.ok(
      manifest.repositories?.length === 3 &&
        manifest.repositories.every(
          (entry) =>
            names.includes(entry?.repo) &&
            entry.head?.length === 40 &&
            /^[a-f0-9]{40}$/.test(entry.head),
        ) &&
        new Set(manifest.repositories.map((entry) => entry.repo)).size === 3,
      "catalog candidate registered tuple",
    );
    for (const entry of manifest.repositories) peers[entry.repo] = entry.head;
  }
  for (const [owner, name] of Object.entries(packages))
    assert.equal(owners[name].commit, peers[repos[owner]], `${owner} scene input`);
}

/** Check full installed Skill bytes against independently frozen author sources. */
export async function assertCatalogSceneSources(readSource) {
  // Full source bytes bind the unchanged rules as well as independently frozen metadata.
  for (const source of fixture.provenance.metadataSources) {
    const bytes = await readSource(source);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      source.sha256,
      `${source.owner} Skill source ${source.file}`,
    );
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
    config: (base) => ({
      cubeMcpCodes: { production: "cube", test: "cube" },
      ...(typeof options.config === "function" ? options.config(base) : options.config),
    }),
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
  await assertCatalogSceneOwners(owners);
  const apsRoot = join(
    combination,
    "node_modules",
    packages.workbench,
    "lib/business/inventory-apsplan",
  );
  const [apsBuild, apsPlugin, apsCapability] = await Promise.all(
    ["build-inputs.json", "plugin.json", "capability.json"].map(async (file) =>
      JSON.parse(await readFile(join(apsRoot, file), "utf8")),
    ),
  );
  assert.ok(["mock", "governed-read"].includes(apsBuild.mode), "declared APS build mode required");
  assert.equal(apsPlugin.mode === "mock", apsBuild.mode === "mock", "APS plugin build mode");
  assert.equal(
    apsCapability.data.mock === true,
    apsBuild.mode === "mock",
    "APS capability build mode",
  );
  await assertCatalogSceneSources((source) =>
    readFile(
      join(
        combination,
        "node_modules",
        packages[source.owner],
        source.file.replace(/^published@0\.11\.3\//, ""),
      ),
    ),
  );
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
  // Every scene declares the same local MCP server schemas, independent of model output.
  const setRoute = app.route;
  app.route = (route) =>
    setRoute(async (req, res, reply) => {
      if (await route(req, res, reply)) return true;
      if (!req.url.pathname.endsWith("/ai/gateway/mcp/proxy/mcp")) return false;
      const wire = JSON.parse(req.body);
      if (wire.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return true;
      }
      const result =
        wire.method === "initialize"
          ? { protocolVersion: wire.params.protocolVersion }
          : wire.method === "tools/list"
            ? { tools: fixtureCubeTools }
            : {
                isError: true,
                structuredContent: {
                  success: false,
                  code: "FIXTURE_QUERY_NOT_DECLARED",
                  message: "This catalog scene has no business query fixture",
                },
              };
      reply({ jsonrpc: "2.0", id: wire.id, result });
      return true;
    });
  app.catalogScene = {
    tools,
    apsMode: apsBuild.mode,
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
