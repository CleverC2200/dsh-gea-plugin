import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { profile } from "./profile.mjs";

test(
  "normal startup loads only built current-source HTML resources and records core provenance",
  { skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 60000 },
  async (t) => {
    const app = await profile(t, { normalStartup: true });
    const response = await fetch(app.origin + "/api/gea-html/plugins", {
      headers: { Cookie: app.cookie },
    });
    assert.equal(response.status, 200);
    const pages = await response.json();
    assert.deepEqual(
      pages.map((page) => page.id),
      ["inventory-fc"],
    );
    assert.equal(pages[0].gea.contract, "gea-html-v2");
    assert.equal(pages[0].agentResources.provider, "dsh-agent-manage");
    const core = JSON.parse(await readFile(join(app.runtime, "core-source.json"), "utf8"));
    const supported = JSON.parse(
      await readFile(new URL("../scripts/current-core.json", import.meta.url), "utf8"),
    );
    assert.equal(supported.upstream, "4878cdabd87d4041bdaff61d04c966883b9fd07a");
    assert.equal(core.version, supported.version);
    assert.equal(core.adaptation, supported.adaptation);
    assert.equal(core.upstream, supported.upstream);
  },
);
