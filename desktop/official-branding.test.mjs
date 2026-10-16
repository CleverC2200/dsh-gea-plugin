import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { officialGeaBranding } from "./official-branding.mjs";
import { planOfficialUpdateConfiguration } from "./configure-official-updates.mjs";

test("GEA branding changes bundle identity and both icon locations while retaining official payload and checks", () => {
  const hook = () => {},
    files = ["lib/main.js", { from: "prepared/dsh", to: "dsh" }];
  const original = {
    productName: "DeepSeek Harness",
    extraMetadata: { dshBuildCommit: "a".repeat(40) },
    mac: { notarize: false },
    files,
    beforePack: hook,
    extraResources: [
      { from: "runtime", to: "runtime" },
      { from: "official.png", to: "icon.png" },
    ],
  };
  const result = officialGeaBranding(original);
  assert.equal(result.productName, "GEA Desktop");
  assert.equal(result.appId, "com.cleverc2200.gea.desktop");
  assert.match(result.mac.icon, /desktop\/build\/icon.png$/);
  assert.equal(result.extraResources[1].from, result.mac.icon);
  assert.equal(result.extraResources[0].from, "runtime");
  assert.equal(result.extraMetadata.dshBuildCommit, original.extraMetadata.dshBuildCommit);
  assert.equal(result.beforePack, hook);
  assert.deepEqual(result.files.slice(0, files.length), files);
  assert.ok(result.files.includes("!renderer/welcome.html"));
  assert.equal(result.files.at(-1).to, "renderer/gea-brand");
  assert.deepEqual(result.files.at(-1).filter, ["icon.png"]);
});

test("company welcome uses only the existing workspace entry and allows retry after a failed open", async () => {
  let click,
    calls = 0;
  const button = {
    disabled: false,
    addEventListener: (_name, callback) => {
      click = callback;
    },
  };
  const status = { textContent: "" };
  runInNewContext(
    readFileSync(new URL("./official-welcome/gea-welcome.js", import.meta.url), "utf8"),
    {
      document: { getElementById: (id) => (id === "company-login" ? button : status) },
      window: {
        dshWelcome: {
          skip: async () => {
            calls++;
            if (calls === 1) throw Error("unavailable");
          },
        },
      },
    },
  );
  await click();
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /重试/);
  await click();
  await click();
  assert.equal(calls, 2);
  assert.equal(button.disabled, true);
});

test("Core deployment replacement preserves source, WeKnora and every unrelated configuration", () => {
  const source = { channel: "stable", channelUrl: "https://example.com/channel.json" };
  const core = { head: "a".repeat(40), version: "0.2.0-rc.2" };
  const rows = [
    { name: "other", config: { login: "retain" } },
    {
      name: "@cleverc2200/gea-dsh-prototype",
      config: {
        knowledge: { baseUrl: "https://knowledge.example.com" },
        pluginUpdates: { source, core, checkTimeoutMs: 60000 },
      },
    },
  ];
  const deployment = {
    source,
    previousHeads: [core.head, "b".repeat(40)],
    core: { ...core, head: "b".repeat(40) },
  };
  const result = planOfficialUpdateConfiguration(rows, deployment);
  assert.equal(result.changed, true);
  assert.deepEqual(result.expected[0], rows[0]);
  assert.deepEqual(result.expected[1].config.knowledge, rows[1].config.knowledge);
  assert.deepEqual(result.updates.source, source);
  assert.equal(result.updates.checkTimeoutMs, 60000);
  assert.equal(planOfficialUpdateConfiguration(result.expected, deployment).changed, false);
  assert.throws(
    () => planOfficialUpdateConfiguration(rows, { ...deployment, previousHeads: [] }),
    /UNEXPECTED_PREVIOUS_CORE/,
  );
  assert.throws(
    () => planOfficialUpdateConfiguration(rows, { ...deployment, source: { channel: "other" } }),
    /UPDATE_SOURCE_CHANGED/,
  );
});
