import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { profile } from "./profile.mjs";
import { prepareWorkbenchHtmlRoots } from "./fixtures/business-page.mjs";

test(
  "the real page catalog binds installed resource summaries without host loader objects",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 60000,
  },
  async (t) => {
    const root = resolve("../dsh-agent-workbench/lib/business/inventory-fc");
    const declared = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
    const skillText = await readFile(resolve(root, declared.skills[0]), "utf8");
    const app = await profile(t, { beforeStart: prepareWorkbenchHtmlRoots([root]) });
    const headers = { Cookie: app.cookie };
    const retired = await fetch(app.origin + "/api/gea-html/plugins", { headers });
    assert.equal(retired.status, 404, "the retired full-manifest route must stay absent");
    const response = await fetch(app.origin + "/api/agent-workbench/pages", { headers });
    assert.equal(response.status, 200);
    const pages = await response.json();
    const pluginPages = pages.filter((item) => item.pluginId === declared.id);
    assert.ok(pluginPages.length > 0);
    const config = await fetch(app.origin + "/api/agent-workbench/config", { headers });
    assert.equal(config.status, 200);
    const { cwd } = await config.json();
    const resourceResponse = await fetch(
      app.origin + "/api/agent-manage/resources?" + new URLSearchParams({ cwd }),
      { headers },
    );
    assert.equal(resourceResponse.status, 200);
    const resources = await resourceResponse.json();
    const resource = resources.find((item) => item.id === "gea-html-" + declared.id);
    assert.ok(resource, "every business page must bind a real installed Manage resource");
    await mkdir(".runtime/public-resources-evidence", { recursive: true });
    await writeFile(
      ".runtime/public-resources-evidence/catalog.json",
      JSON.stringify(
        {
          pages: pluginPages,
          resource,
          retiredStatus: retired.status,
        },
        null,
        2,
      ),
    );
    const declaredPages = declared.pages ?? [{ id: declared.id, name: declared.name, view: "" }];
    assert.deepEqual(
      pluginPages.map(({ id, name, view }) => ({ id, name, view })),
      declaredPages.map(({ id, name, view }) => ({ id, name, view })),
    );
    for (const page of pluginPages) {
      assert.equal(page.resourceId, resource.id);
      assert.equal(
        page.url,
        "/api/agent-workbench/html?" + new URLSearchParams({ id: page.id, page: page.view }),
      );
      assert.equal(typeof page.order, "number");
      assert.deepEqual(Object.keys(page).sort(), [
        "id",
        "name",
        "order",
        "pluginId",
        "resourceId",
        "url",
        "view",
      ]);
      assert.equal(Object.hasOwn(page, "skillText"), false, "loaded Skill text is Host-only");
    }
    assert.equal(resource.kind, "prompt");
    assert.equal(resource.label, declared.name);
    assert.equal(resource.installed, true);
    assert.equal(resource.enabled, true);
    assert.equal(resource.provider, "package");
    assert.ok(resource.skills.includes(declared.id));
    const publicBody = JSON.stringify({ pages, resources });
    assert.doesNotMatch(publicBody, /"(?:skillPath|promptPath|loadedAgentResources|skillText)"/);
    assert.ok(
      !publicBody.includes(JSON.stringify(skillText).slice(1, -1)),
      "the full loaded Skill must not be serialized under another field",
    );
    assert.ok(!publicBody.includes(root));
    assert.ok(!publicBody.includes(app.runtime));
  },
);
