const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");

function start(ownsLock) {
  const events = [];
  const env = {};
  runInNewContext(readFileSync(__dirname + "/official-main.cjs", "utf8"), {
    __dirname: "/app",
    process: { execPath: "/app/GEA", resourcesPath: "/resources", env },
    require(name) {
      if (name === "node:path") return require(name);
      if (name === "electron")
        return {
          app: {
            requestSingleInstanceLock() {
              events.push("lock");
              return ownsLock;
            },
            quit() {
              events.push("quit");
            },
            getPath() {
              return "/user/AppData/Roaming";
            },
          },
        };
      if (name === "node:child_process")
        return {
          spawnSync(exe, args) {
            events.push(["bootstrap", exe, ...args]);
            return { status: 0 };
          },
        };
      if (name === "./lib/main.js") {
        assert.equal(env.GEA_COMPANY_CLIENT, "1");
        events.push("official-main");
      } else throw Error(name);
    },
  });
  return events;
}

test("a second desktop instance never starts bootstrap or cleanup", () => {
  assert.deepEqual(start(false), ["lock", "quit"]);
});

test("the owning desktop bootstraps with the exact legacy GEA root before loading official main", () => {
  const events = start(true);
  assert.equal(events[0], "lock");
  assert.equal(events[1][0], "bootstrap");
  assert.equal(events[1].at(-1), "/user/AppData/Roaming/dsh-gea-desktop");
  assert.equal(events[2], "official-main");
});

test("the bundled model picker policy applies only in the company client", () => {
  const { parseDocument } = require("yaml");
  const document = parseDocument(readFileSync(__dirname + "/../cordis.patch.yml", "utf8"), {
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => ({ expression: value }) }],
  });
  assert.deepEqual(document.errors, []);
  const rows = document.toJS();
  const expression = rows.find((row) => row.id === "ui-model-selection").config.visibleProviders
    .expression;
  const ordinary = runInNewContext(expression, { process: { env: {} } });
  assert.equal(ordinary, undefined);
  const company = runInNewContext(expression, { process: { env: { GEA_COMPANY_CLIENT: "1" } } });
  assert.deepEqual(Array.from(company), ["gea-analysis"]);
});

test("the company desktop packages every module used by cleanup and refresh", async () => {
  const { officialGeaBranding } = await import("./official-branding.mjs");
  const result = officialGeaBranding(
    { files: [], extraResources: [], extraMetadata: {} },
    { companySeed: "/seed" },
  );
  const files = result.files.find((row) => typeof row === "object" && row.to === ".").filter;
  for (const file of [
    "official-main.cjs",
    "company-bootstrap.mjs",
    "company-gea-refresh.mjs",
    "company-archives.mjs",
    "legacy-gea-cleanup.mjs",
    "plugin-storage.mjs",
    "plugin-store-lock.mjs",
    "physical-fs.mjs",
  ])
    assert.ok(files.includes(file), file);
});
