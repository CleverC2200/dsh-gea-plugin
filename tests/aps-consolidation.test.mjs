import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";

test("APS V0.2 replaces legacy plugin routes and tools without GEA login", async () => {
  const runtime = await mkdtemp(resolve(tmpdir(), "aps-mock-"));
  const routes = new Map();
  const tools = [];
  const cleanups = [];
  const ctx = {
    effect(callback) {
      const cleanup = callback();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
  };
  const business = {
    config: { runtimeDir: runtime },
    watchIdentity: () => () => {},
    status: () => ({ authenticated: false }),
    pageSessionScope: () => undefined,
  };
  const call = async (path, body) =>
    routes.get(path).fetch(
      new Request("https://dsh.example" + path, body === undefined ? {} : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  try {
    const ids = ["inventory-apsplan", "inventory-apsboard", "inventory-apsdemand", "inventory-apsdelivery"];
    const roots = await Promise.all(ids.map(async id => {
      const directory = resolve(runtime, id);
      await mkdir(directory);
      const consumer = { consumerCode: id, consumerType: "AGENT" };
      await writeFile(resolve(directory, "plugin.json"), JSON.stringify({
        schemaVersion: 1, id, name: id, mode: "mock", html: "index.html",
        skills: ["SKILL.md"], mcp: "mcp.json",
        gea: { consumerCode: id, readonly: true, contract: "gea-html-v1" },
        ...(id === "inventory-apsplan" ? { replaces: ids.slice(1) } : {}),
      }));
      await writeFile(resolve(directory, "mcp.json"), JSON.stringify({
        provider: "gea", transport: "host-provided", contract: "gea-html-v1",
        consumer, capabilities: ["governed-sql-read"],
      }));
      await writeFile(resolve(directory, "SKILL.md"), "Local demonstration only.");
      await writeFile(resolve(directory, "index.html"), "<!doctype html><title>APS</title>");
      return directory;
    }));
    const api = await registerHtmlPlugins(ctx, business, roots);
    const manifests = await (await call("/api/gea-html/plugins")).json();
    assert.deepEqual(manifests.map((item) => item.id), [
      "inventory-apsplan",
    ]);
    assert.deepEqual(manifests.flatMap((item) => item.pages.map((page) => page.id)), [
      "inventory-apsplan",
    ]);
    assert.equal(routes.has("/api/gea-html/inventory-apsdemand/open"), false);
    assert.ok(manifests.every((item) => item.mode === "mock"));
    const session = "session-11111111-1111-1111-1111-111111111111";
    const opened = await (await call("/api/gea-html/inventory-apsplan/open", { session })).json();
    assert.ok(opened.lease);
    assert.equal(api.consumerForSession(session), undefined);
    const access = await (await call("/api/gea-html/inventory-apsplan/call", {
      lease: opened.lease,
      method: "access",
    })).json();
    assert.equal(access.mode, "mock");
    assert.equal(
      (await call("/api/gea-html/inventory-apsplan/call", {
        lease: opened.lease,
        method: "sql",
        parameters: {},
      })).status,
      400,
    );
    assert.deepEqual(tools.map((tool) => tool.name), [
      "gea_page",
    ]);
  } finally {
    cleanups.forEach((cleanup) => cleanup());
    await rm(runtime, { recursive: true, force: true });
  }
});
