import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boot } from "@deepseek-ai/dsh-app-boot";
import * as gea from "../lib/host.js";

// The production Loader and GEA Host run here; unrelated public services are local recording adapters.
async function start(home, config = {}) {
  const dir = join(home, "profiles", "ordinary");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "cordis.yml");
  await writeFile(file, "[]\n");
  const routes = new Map(),
    resources = [],
    models = [],
    guards = [];
  const dispose = () => {};
  const ctx = await boot(
    "ordinary-test",
    file,
    [{ insert: [{ id: "gea-proof", name: "cordis:fixture-gea", config }] }],
    (ctx) => {
      ctx.provide("profileContext", {
        name: "ordinary",
        dir,
        home,
        cwd: "/Applications/App/Contents",
        patchPath: join(dir, "cordis.patch.yml"),
        installAnchor: join(home, "package.json"),
        startedBundles: [],
        overlays: [],
        telemetryDisabledEnv: undefined,
      });
      ctx.provide("connection", {
        fetch: {
          register: (route) => {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        },
      });
      ctx.provide("workbenchPages", { packages: () => [], registerBusinessPage: () => dispose });
      ctx.provide("agentResources", {
        register: async (rows) => {
          resources.push(...rows);
          return dispose;
        },
      });
      ctx.provide("agents", { get: () => undefined });
      ctx.provide("tools", {
        register: () => dispose,
        guard: (fn) => {
          guards.push(fn);
          return dispose;
        },
        schemas: () => [],
        restrict: () => dispose,
      });
      ctx.provide("skills", { get: async () => undefined });
      ctx.provide("llm", {
        registerAdapter: (providers) => {
          const release = () => {};
          release.replace = (value) => models.push(value);
          models.push(providers);
          return release;
        },
      });
      ctx.provide("sessionController", {});
      ctx.provide("sessionProjections", {});
      ctx.provide("agentDefaultModel", {});
      ctx.provide("agentPresets", {});
      ctx.loader.builtins["fixture-gea"] = gea;
    },
  );
  return { ctx, dir, routes, resources, models, guards };
}

test("ordinary Loader mounts GEA with empty settings and a profile-owned runtime directory without network or login", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gea-ordinary-profile-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw Error("EXTERNAL_REQUEST_FORBIDDEN");
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const f = await start(home);
  t.after(() => f.ctx.fiber.dispose());
  assert.equal((await stat(join(f.dir, "gea"))).isDirectory(), true);
  assert.equal(f.resources[0].id, "gea-readonly");
  assert.deepEqual(f.models, [["gea-analysis"], []]);
  const status = await f.routes.get("/api/gea-proof/status").fetch(
    new Request("http://localhost/api/gea-proof/status", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    }),
  );
  const value = await status.json();
  assert.equal(value.value.authenticated, false);
  assert.equal(value.value.environment, "production");
  assert.deepEqual(value.value.environments, ["production", "test"]);
  const identity = await (
    await f.routes
      .get("/api/gea-html/identity")
      .fetch(new Request("http://localhost/api/gea-html/identity"))
  ).json();
  assert.equal(identity.status.environment, "production");
  assert.deepEqual(identity.status.environments, ["production", "test"]);
  assert.equal(requests, 0);
  assert.match(f.guards[0]({ name: "gea_evidence_read" }), /GEA_BUSINESS_PROFILE_REQUIRED/);
  await f.ctx.fiber.dispose();
  const restarted = await start(home);
  await restarted.ctx.fiber.dispose();
  assert.equal(requests, 0);
});

test("ordinary Loader preserves explicit runtime directory and rejects invalid absolute file paths", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gea-ordinary-explicit-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtimeDir = join(home, "custom-data");
  const f = await start(home, { runtimeDir, geaBaseUrl: "https://explicit.example.test/gea" });
  assert.equal((await stat(runtimeDir)).isDirectory(), true);
  const status = await (
    await f.routes.get("/api/gea-proof/status").fetch(
      new Request("http://localhost/api/gea-proof/status", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      }),
    )
  ).json();
  assert.equal(status.value.environment, "production");
  assert.deepEqual(status.value.environments, ["production"]);
  assert.equal(status.value.source, "https://explicit.example.test/gea");
  await f.ctx.fiber.dispose();
  const invalid = join(home, "file");
  await writeFile(invalid, "fixture");
  for (const path of [invalid, "relative"]) {
    await assert.rejects(
      gea.apply({ profileContext: { dir: home } }, gea.Config({ runtimeDir: path })),
    );
    const rejected = await start(home, { runtimeDir: path });
    assert.equal(rejected.routes.size, 0);
    await rejected.ctx.fiber.dispose();
  }
});

test("ordinary Loader preserves the configured environment map and selected test environment", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gea-ordinary-environments-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const f = await start(home, {
    environment: "test",
    geaEnvironments: {
      production: "https://production.example/gea",
      test: "https://test.example/gea",
    },
  });
  t.after(() => f.ctx.fiber.dispose());
  const status = await (
    await f.routes.get("/api/gea-proof/status").fetch(
      new Request("http://localhost/api/gea-proof/status", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      }),
    )
  ).json();
  assert.equal(status.value.environment, "test");
  assert.deepEqual(status.value.environments, ["production", "test"]);
  assert.equal(status.value.source, "https://test.example/gea");
});
