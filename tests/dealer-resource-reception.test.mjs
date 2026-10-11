import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { registerHtmlPlugins } from "../src/html-plugins.ts";
import { BusinessResources } from "dsh-agent-manage/business-resources";
const session = "session-11111111-1111-4111-8111-111111111111";

for (const enabled of [true, false])
  test(`actual built dealer resource ${enabled ? "selects" : "refuses selection"} while its static page remains registered`, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dealer-reception-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(resolve("../dsh-agent-workbench/lib/business/inventory-dealer"), root, {
      recursive: true,
    });
    const capability = JSON.parse(await readFile(join(root, "capability.json"), "utf8"));
    capability.enabled = enabled;
    capability.data.mock = true;
    await writeFile(join(root, "capability.json"), JSON.stringify(capability));
    const page = JSON.parse(await readFile(join(root, "page.json"), "utf8"));
    page.visible = false;
    await writeFile(join(root, "page.json"), JSON.stringify(page));
    const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
    manifest.mode = "mock";
    await writeFile(join(root, "plugin.json"), JSON.stringify(manifest));
    const mcp = JSON.parse(await readFile(join(root, "mcp.json"), "utf8"));
    mcp.capabilities = [];
    await writeFile(join(root, "mcp.json"), JSON.stringify(mcp));
    assert.equal(manifest.mode, "mock");
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
          assert.equal(id, "standard");
          const require = createRequire(import.meta.url);
          const managed = createRequire(require.resolve("dsh-agent-manage/business-resources"));
          const { entryListSchema } = await import(
            pathToFileURL(managed.resolve("@deepseek-ai/cordis-plugin-include"))
          );
            const { load, dump } = await import(pathToFileURL(managed.resolve("js-yaml")));
          const core = resolve(
            dirname(await realpath(require.resolve("@deepseek-ai/dsh/package.json"))),
            "../..",
          );
          const rows = load(
            await readFile(
              join(core, "packages/bundle/web-app/presets/standard.patch.yml"),
              "utf8",
            ),
            { schema: entryListSchema },
          );
          return { content: dump(rows[0].insert[0].config.plugins, { schema: entryListSchema }) };
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
      assert.equal((await ctx.agentResources.select(id, new AbortController().signal)).preset, id);
    else
      await assert.rejects(
        ctx.agentResources.select(id, new AbortController().signal),
        /AGENT_RESOURCE_DISABLED_OR_MISSING/,
      );
    assert.equal(pages.has("inventory-dealer"), true);
    const grant = await pages.get("inventory-dealer")(session, id, new AbortController().signal);
    assert.equal(grant.access.mode, "mock");
    assert.equal(grant.allowsEffect("view"), enabled);
    for (const effect of ["draft", "submit", "approve"])
      assert.equal(grant.allowsEffect(effect), false);
    await assert.rejects(grant.readSql({}, new AbortController().signal), /MOCK_DATA_ONLY/);
    grant.release();
  });
