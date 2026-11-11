import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";
import { runInNewContext } from "node:vm";
import { officialGeaBranding, prepareOfficialGeaMain } from "./official-branding.mjs";
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
  assert.equal(result.productName, "Synear GEA");
  assert.equal(result.extraMetadata.productName, "Synear GEA");
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

test("company packaging brands native copy without changing the Core build or runtime identifiers", async (t) => {
  const desktop = await mkdtemp(join(tmpdir(), "gea-branding-"));
  t.after(() => rm(desktop, { recursive: true, force: true }));
  await mkdir(join(desktop, "lib"));
  const source =
    'globalThis.copy = { about: "About DeepSeek Harness", quit: "退出 DeepSeek Harness", id: "@deepseek-ai/dsh-desktop", scheme: "dsh" };';
  await writeFile(join(desktop, "lib/main.js"), source);
  const brandedMain = await prepareOfficialGeaMain(desktop, desktop);
  assert.equal(basename(brandedMain), "main.js");
  assert.equal(dirname(brandedMain), join(desktop, "company-main"));
  const runtime = {};
  runInNewContext(await readFile(brandedMain, "utf8"), runtime);
  assert.equal(runtime.copy.about, "About Synear GEA");
  assert.equal(runtime.copy.quit, "退出 Synear GEA");
  assert.equal(runtime.copy.id, "@deepseek-ai/dsh-desktop");
  assert.equal(runtime.copy.scheme, "dsh");
  assert.equal(await readFile(join(desktop, "lib/main.js"), "utf8"), source);
  const config = officialGeaBranding(
    {
      files: ["lib/main.js", "lib/preload-app.cjs"],
      extraResources: [],
      protocols: [{ name: "DeepSeek Harness", schemes: ["dsh"] }],
    },
    { brandedMain },
  );
  assert.equal(config.files.includes("lib/main.js"), false);
  assert.ok(config.files.includes("lib/preload-app.cjs"));
  assert.deepEqual(
    config.files.find((file) => file.to === "lib"),
    {
      from: dirname(brandedMain),
      to: "lib",
      filter: ["main.js"],
    },
  );
  assert.deepEqual(config.protocols, [{ name: "Synear GEA", schemes: ["dsh"] }]);
  await writeFile(join(desktop, "lib/main.js"), "unknown Core build");
  await assert.rejects(prepareOfficialGeaMain(desktop, desktop), /BRANDING_DRIFT/);
});

test("company launcher retains Electron settings and brands page titles without losing the session title", () => {
  let created, titleUpdated, data, title, directory;
  const app = {
    getPath: () => "/existing/appData",
    setPath: (_name, path) => {
      assert.equal(path, directory);
      data = path;
    },
    on: (_name, handler) => {
      created = handler;
    },
    requestSingleInstanceLock: () => false,
    quit: () => {},
  };
  runInNewContext(readFileSync(new URL("./official-main.cjs", import.meta.url), "utf8"), {
    require: (name) => {
      if (name === "electron") return { app };
      if (name === "node:path") return { join };
      if (name === "node:fs")
        return {
          mkdirSync: (path) => {
            directory = path;
          },
        };
      return {};
    },
  });
  assert.equal(data, "/existing/appData/GEA Desktop");
  created(
    {},
    {
      on: (_name, handler) => {
        titleUpdated = handler;
      },
      setTitle: (value) => {
        title = value;
      },
    },
  );
  let prevented = false;
  const event = {
    preventDefault: () => {
      prevented = true;
    },
  };
  titleUpdated(event, "销售计划 — DeepSeek Harness");
  assert.equal(prevented, true);
  assert.equal(title, "销售计划 — Synear GEA");
  titleUpdated(event, "DeepSeek Harness 使用记录 — DeepSeek Harness");
  assert.equal(title, "DeepSeek Harness 使用记录 — Synear GEA");
  prevented = false;
  titleUpdated(event, "正在下载更新");
  assert.equal(prevented, false);
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
