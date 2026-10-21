import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { profile } from "./profile.mjs";
import { findSupportedCore, readSupportedCore } from "../scripts/supported-cores.mjs";

test(
  "normal startup loads only built current-source HTML resources and records core provenance",
  { skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 60000 },
  async (t) => {
    const app = await profile(t, { normalStartup: true });
    const headers = { Cookie: app.cookie };
    const retired = await fetch(app.origin + "/api/gea-html/plugins", { headers });
    assert.equal(retired.status, 404, "the retired full-manifest route must stay absent");
    const response = await fetch(app.origin + "/api/agent-workbench/pages", { headers });
    assert.equal(response.status, 200);
    const pages = await response.json();
    const selected = JSON.parse(await readFile(join(app.runtime, "source-selection.json"), "utf8"));
    const installed = join(
      app.runtime,
      "source-combinations",
      selected.id,
      "node_modules",
      "@cleverc2200/dsh-agent-workbench",
      "lib",
    );
    // Match the whole default catalog against the selected snapshot's authored declarations.
    // There is no single-FC override or filtering of the actual response.
    const declaredPages = [];
    for (const directory of [
      "samples",
      ...["regional", "category", "mps"].map((id) => "static/" + id),
      ...[
        "fc",
        "aqkc",
        "dealer",
        "qll",
        "customer",
        "orderworkbench",
        "orderfulfillment",
        "apsplan",
      ].map((id) => "business/inventory-" + id),
    ]) {
      const root = join(installed, directory);
      const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
      if (manifest.declarations?.page) {
        const declaration = JSON.parse(
          await readFile(join(root, manifest.declarations.page), "utf8"),
        );
        if (declaration.visible === false) continue;
      }
      for (const page of manifest.pages ?? [{ id: manifest.id, name: manifest.name, view: "" }])
        declaredPages.push({
          id: page.id,
          name: page.name,
          view: page.view,
          pluginId: manifest.id,
          resourceId:
            manifest.gea?.contract === "gea-html-v2" ? "gea-html-" + manifest.id : undefined,
        });
    }
    assert.deepEqual(
      pages.map(({ id, name, view, pluginId, resourceId }) => ({
        id,
        name,
        view,
        pluginId,
        resourceId,
      })),
      declaredPages,
    );
    assert.ok(pages.some((page) => page.id === "inventory-fc"));
    const configResponse = await fetch(app.origin + "/api/agent-workbench/config", { headers });
    assert.equal(configResponse.status, 200);
    const { cwd } = await configResponse.json();
    const resourcesResponse = await fetch(
      app.origin + "/api/agent-manage/resources?" + new URLSearchParams({ cwd }),
      { headers },
    );
    assert.equal(resourcesResponse.status, 200);
    const resources = await resourcesResponse.json();
    for (const page of pages) {
      assert.equal(
        page.url,
        "/api/agent-workbench/html?" + new URLSearchParams({ id: page.id, page: page.view }),
      );
      if (page.resourceId) {
        const resource = resources.find((row) => row.id === page.resourceId);
        assert.ok(resource, "declared business page must bind an installed Manage resource");
        assert.equal(resource.installed, true);
        assert.equal(resource.kind, "prompt");
      }
    }
    assert.doesNotMatch(
      JSON.stringify({ pages, resources }),
      /"(?:skillPath|promptPath|loadedAgentResources|skillText)"/,
    );
    assert.ok(!JSON.stringify({ pages, resources }).includes(app.runtime));
    const core = JSON.parse(await readFile(join(app.runtime, "core-source.json"), "utf8"));
    const supported = JSON.parse(
      await readFile(new URL("../scripts/current-core.json", import.meta.url), "utf8"),
    );
    assert.equal(supported.upstream, "5badb15009ae1756c3afe0ae0cef1faafc290ccc");
    assert.ok(findSupportedCore({ head: supported.adaptation, version: supported.version }));
    const actual = await readSupportedCore(resolve("../../official-latest-standard"));
    assert.equal(actual.id, undefined, "the runtime must use an official CI axis");
    assert.equal(core.version, actual.version);
    assert.equal(core.adaptation, actual.head);
    assert.equal(core.upstream, actual.head);
    assert.equal(core.dirty, "");
  },
);
