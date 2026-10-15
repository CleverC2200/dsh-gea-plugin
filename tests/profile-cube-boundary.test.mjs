import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:https";
import { readFile } from "node:fs/promises";
import { profile } from "./profile.mjs";

function wire(base, method, params = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      base + "/ai/gateway/mcp/proxy/mcp",
      {
        method: "POST",
        rejectUnauthorized: false,
        headers: { "Content-Type": "application/json" },
      },
      async (res) => {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode,
          body: body ? JSON.parse(body) : undefined,
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  });
}

test("profile supplies loopback Cube discovery but never invents a business response", async (t) => {
  const inspected = new Error("fixture boundary inspected before Core startup");
  await assert.rejects(
    profile(t, {
      coreOnly: true,
      async beforeStart({ config }) {
        const settings = JSON.parse(await readFile(config, "utf8"));
        assert.deepEqual(settings.cubeMcpCodes, {
          production: "cube",
          test: "cube",
        });
        const initialized = await wire(settings.geaBaseUrl, "initialize", {
          protocolVersion: "2024-11-05",
        });
        assert.equal(initialized.body.result.protocolVersion, "2024-11-05");
        const listed = await wire(settings.geaBaseUrl, "tools/list");
        assert.deepEqual(
          listed.body.result.tools.map((tool) => tool.name),
          ["inspect_cube_model", "query_business_data"],
        );
        assert.equal(
          (await wire(settings.geaBaseUrl, "notifications/initialized")).status,
          202,
        );
        const called = await wire(settings.geaBaseUrl, "tools/call", {
          name: "query_business_data",
          arguments: {},
        });
        assert.equal(called.status, 404);
        assert.deepEqual(called.body, { message: "fixture route absent" });
        throw inspected;
      },
    }),
    (error) => error === inspected,
  );
});

test("scenario configuration and explicit gateway denial precede fixture discovery", async (t) => {
  const inspected = new Error("explicit gateway inspected");
  await assert.rejects(
    profile(t, {
      coreOnly: true,
      config: {
        cubeMcpCodes: {
          production: "scenario-production",
          test: "scenario-test",
        },
      },
      route(req, _res, reply) {
        if (!req.url.pathname.endsWith("/ai/gateway/mcp/proxy/mcp"))
          return false;
        reply({ code: "SCENARIO_GATEWAY_DENIED" }, 403);
        return true;
      },
      async beforeStart({ config }) {
        const settings = JSON.parse(await readFile(config, "utf8"));
        assert.deepEqual(settings.cubeMcpCodes, {
          production: "scenario-production",
          test: "scenario-test",
        });
        assert.deepEqual(
          await wire(settings.geaBaseUrl, "tools/call", {
            name: "query_business_data",
            arguments: {},
          }),
          {
            status: 403,
            body: { code: "SCENARIO_GATEWAY_DENIED" },
          },
        );
        throw inspected;
      },
    }),
    (error) => error === inspected,
  );
});

test("a scenario can omit Cube configuration without inventing business tool results", async (t) => {
  const inspected = new Error("missing configuration inspected");
  let transports = 0;
  await assert.rejects(
    profile(t, {
      coreOnly: true,
      config: () => ({ cubeMcpCodes: undefined }),
      route() {
        transports++;
        return false;
      },
      async beforeStart({ config }) {
        const settings = JSON.parse(await readFile(config, "utf8"));
        assert.equal(Object.hasOwn(settings, "cubeMcpCodes"), false);
        // Knowledge can use the shared gateway without Cube. Omitting Cube must
        // still leave this fixture's business tool response unavailable.
        assert.deepEqual(
          await wire(settings.geaBaseUrl, "tools/call", {
            name: "query_business_data",
            arguments: {},
          }),
          {
            status: 404,
            body: { message: "fixture route absent" },
          },
        );
        assert.equal(transports, 1);
        throw inspected;
      },
    }),
    (error) => error === inspected,
  );
});
