import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";
import { compiledSource } from "./fixtures/compiled-source.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readSupportedCore } from "../scripts/supported-cores.mjs";
async function managedResources(t) {
  await mkdir(".runtime", { recursive: true });
  const source = resolve("../dsh-agent-manage");
  const module = await compiledSource(t, {
    contents: "export { BusinessResources } from './src/runtime/business-resources.ts'",
    source,
    dependencies: join(source, "node_modules"),
    url: join(source, "src/runtime/business-resources.ts"),
    parent: resolve(".runtime"),
  });
  const core = resolve("../../official-latest-standard");
  await readSupportedCore(core);
  const { entryListSchema } = await import(
    pathToFileURL(join(core, "vendor/include/lib/index.js"))
  );
  const { load, dump } = createRequire(join(core, "vendor/include/package.json"))("js-yaml");
  const standard = load(
    await readFile(join(core, "packages/bundle/web-app/presets/standard.patch.yml"), "utf8"),
    { schema: entryListSchema },
  )[0].insert[0].config;
  assert.equal(standard.id, "standard");
  return {
    BusinessResources: module.BusinessResources,
    standardDocument: {
      agentPreset: standard.id,
      content: dump(standard.plugins, { schema: entryListSchema, noRefs: true, lineWidth: -1 }),
    },
  };
}
const session = "session-11111111-1111-4111-8111-111111111111";

for (const mock of [false, true])
  for (const enabled of [true, false])
    test(`${mock ? "isolated mock dealer fixture" : "actual built dealer resource"} ${enabled ? "selects" : "refuses selection"} while its static page remains registered`, async (t) => {
      const { BusinessResources, standardDocument } = await managedResources(t);
      const root = await realpath(await mkdtemp(join(tmpdir(), "dealer-reception-")));
      t.after(() => rm(root, { recursive: true, force: true }));
      await cp(resolve("../dsh-agent-workbench/lib/business/inventory-dealer"), root, {
        recursive: true,
      });
      const capability = JSON.parse(await readFile(join(root, "capability.json"), "utf8"));
      capability.enabled = enabled;
      if (mock) capability.data.mock = true;
      await writeFile(join(root, "capability.json"), JSON.stringify(capability));
      const page = JSON.parse(await readFile(join(root, "page.json"), "utf8"));
      page.visible = false;
      await writeFile(join(root, "page.json"), JSON.stringify(page));
      const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
      const mcp = JSON.parse(await readFile(join(root, "mcp.json"), "utf8"));
      if (mock) {
        manifest.mode = "mock";
        mcp.capabilities = [];
        await writeFile(join(root, "plugin.json"), JSON.stringify(manifest));
        await writeFile(join(root, "mcp.json"), JSON.stringify(mcp));
      } else {
        assert.equal(manifest.mode, undefined);
        assert.notEqual(capability.data.mock, true);
        assert.deepEqual(mcp.capabilities, ["governed-sql-read"]);
      }
      const pages = new Map(),
        presets = new Map(),
        cleanups = [],
        surfaces = new Map(),
        identities = new Map();
      let provider;
      const ctx = {
        effect(fn) {
          const off = fn();
          if (typeof off === "function") cleanups.push(off);
        },
        skills: {
          registerProvider(create) {
            provider = create({
              invalidate() {},
              signal: new AbortController().signal,
            });
            return () => {};
          },
          list: (options) => provider.list(options),
        },
        agentPresets: {
          async readDocument(id) {
            assert.equal(id, standardDocument.agentPreset);
            return standardDocument;
          },
          async register(definition) {
            presets.set(definition.id, definition);
            return async () => presets.delete(definition.id);
          },
          async resolve(id) {
            return { id };
          },
        },
        connection: {
          fetch: {
            register() {
              return () => {};
            },
          },
        },
        workbenchPages: {
          registerBusinessPage(page, authorize) {
            pages.set(page.id, authorize);
            return () => pages.delete(page.id);
          },
        },
      };
      ctx.agentResources = new BusinessResources(ctx, join(root, "selected.json"));
      t.after(() => ctx.agentResources.dispose());
      const business = {
        status: () => ({ authenticated: false }),
        pageSessionScope: () => undefined,
        setSurface(id, value) {
          surfaces.set(id, value);
          return value;
        },
        surfaceFor: (id) => surfaces.get(id),
        clearSurface: (id) => surfaces.delete(id),
        touchPageIdentity: (id, value) => identities.set(id, value),
        currentPageIdentity: (id) => identities.get(id),
        clearPageIdentity: (id) => identities.delete(id),
        htmlLaunch() {
          assert.fail("no real Consumer launch");
        },
        pluginSql() {
          assert.fail("no SQL");
        },
      };
      t.after(async () => {
        for (const off of cleanups.reverse()) await off();
      });
      await registerHtmlPlugins(ctx, business, [
        { directory: root, htmlPath: join(root, "index.html"), manifest },
      ]);
      const id = "gea-html-inventory-dealer";
      assert.equal((await ctx.agentResources.list()).find((row) => row.id === id).enabled, enabled);
      if (enabled)
        assert.equal(
          (await ctx.agentResources.select(id, new AbortController().signal)).preset,
          id,
        );
      else
        await assert.rejects(
          ctx.agentResources.select(id, new AbortController().signal),
          /AGENT_RESOURCE_DISABLED_OR_MISSING/,
        );
      assert.equal(pages.has("inventory-dealer"), true);
      if (!mock) {
        await assert.rejects(
          pages.get("inventory-dealer")(session, id, new AbortController().signal),
          /PAGE_REFERENCE_LOGIN_REQUIRED/,
        );
        return;
      }
      const grant = await pages.get("inventory-dealer")(session, id, new AbortController().signal);
      assert.equal(grant.access.mode, "mock");
      assert.equal(grant.allowsEffect("view"), enabled);
      for (const effect of ["draft", "submit", "approve"])
        assert.equal(grant.allowsEffect(effect), false);
      await assert.rejects(grant.readSql({}, new AbortController().signal), /MOCK_DATA_ONLY/);
      grant.release();
    });
