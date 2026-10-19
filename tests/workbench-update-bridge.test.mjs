import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";

const moduleUrl = (code) => "data:text/javascript," + encodeURIComponent(code);
const salesOutput = await build({
  entryPoints: ["../dsh-agent-workbench/src/sales-plan.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const salesUrl = moduleUrl(salesOutput.outputFiles[0].text);
const sales = await import(salesUrl);
async function subject(t, entry, { oldSales = false, configured = "current" } = {}) {
  await mkdir(".runtime", { recursive: true });
  const directory = await mkdtemp(resolve(".runtime", "workbench-bridge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = await build({
    entryPoints: [entry],
    bundle: true,
    packages: "external",
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const path = resolve(directory, "subject.mjs");
  await writeFile(path, output.outputFiles[0].text);
  const exports = Object.keys(sales).filter(
    (name) =>
      !oldSales || !["salesPlanCanResubmit", "salesPlanPeriodMonthForPlanId"].includes(name),
  );
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@cleverc2200/dsh-agent-workbench/sales-plan")
        return {
          shortCircuit: true,
          url: moduleUrl(`export {${exports.join(",")}} from ${JSON.stringify(salesUrl)};`),
        };
      if (
        specifier === "@cleverc2200/dsh-agent-workbench/configured-query" &&
        configured === "missing"
      )
        throw Object.assign(
          Error(
            "Package subpath './configured-query' is not defined by exports in @cleverc2200/dsh-agent-workbench/package.json",
          ),
          { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
        );
      if (
        specifier === "@cleverc2200/dsh-agent-workbench/configured-query" &&
        configured === "missing-package"
      )
        throw Object.assign(Error("CONFIGURED_PACKAGE_NOT_FOUND"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      if (
        specifier === "@cleverc2200/dsh-agent-workbench/configured-query" &&
        configured === "broken-dependency"
      )
        return {
          shortCircuit: true,
          url: moduleUrl(
            'throw Object.assign(Error("CONFIGURED_DEPENDENCY_NOT_EXPORTED"), {code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});',
          ),
        };
      return next(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  return import(pathToFileURL(path).href);
}

test("GEA Host exports remain loadable before Workbench adds new sales and configured-query capabilities", async (t) => {
  const host = await subject(t, "src/host.ts", { oldSales: true, configured: "missing" });
  assert.equal(typeof host.apply, "function");
  assert.equal(host.Config({}).analysisMode, "model");
});

function businessFixture(t, Business, serviceAccounts) {
  const business = new Business({
    geaBaseUrl: "https://fixture.invalid",
    requestTimeoutMs: 2000,
    inputByteBudget: 32000,
    pageSize: 20,
    periodPageSize: 100,
    analysisAgentCode: "sales_forecast",
    serviceAccounts,
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://fixture.invalid",
    auth: { token: "fixture-token", tenantId: "0", id: "user", name: "User", username: "user" },
  });
  t.after(() => business.dispose());
  return business;
}

test("old Workbench refuses the new period index before querying rather than inventing a month", async (t) => {
  const { Business } = await subject(t, "src/host/business.ts", { oldSales: true });
  const business = businessFixture(t, Business);
  const external = t.mock.method(globalThis, "fetch", () => {
    throw Error("UNEXPECTED_EXTERNAL_READ");
  });
  await assert.rejects(
    business.workbenchQuery({ kind: "periods", query: {} }, new AbortController().signal),
    (error) =>
      error.code === "GEA_WORKBENCH_UPDATE_REQUIRED" && /Workbench.*更新/.test(error.message),
  );
  assert.equal(external.mock.callCount(), 0);
});

test("old Workbench refuses resubmission before service authentication or business requests", async (t) => {
  const { Business } = await subject(t, "src/host/business.ts", { oldSales: true });
  process.env.GEA_BRIDGE_CLIENT = "fixture-client";
  process.env.GEA_BRIDGE_SECRET = "fixture-secret";
  t.after(() => {
    delete process.env.GEA_BRIDGE_CLIENT;
    delete process.env.GEA_BRIDGE_SECRET;
  });
  const business = businessFixture(t, Business, {
    production: {
      clientIdEnv: "GEA_BRIDGE_CLIENT",
      clientSecretEnv: "GEA_BRIDGE_SECRET",
      tenantId: "0",
      allowedUserIds: ["user"],
    },
  });
  const external = t.mock.method(globalThis, "fetch", () => {
    throw Error("UNEXPECTED_EXTERNAL_REQUEST");
  });
  await assert.rejects(
    business.salesPlanSubmit(
      {
        source: { planId: "plan", versionId: "version" },
        request: {},
        requestId: "request",
        idempotencyKey: "intent",
      },
      new AbortController().signal,
    ),
    (error) =>
      error.code === "GEA_WORKBENCH_UPDATE_REQUIRED" && /Workbench.*更新/.test(error.message),
  );
  assert.equal(external.mock.callCount(), 0);
});

async function configuredResource(t) {
  const directory = await mkdtemp(resolve(".runtime", "configured-bridge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    resolve(directory, "sql.config.json"),
    JSON.stringify({ schemaVersion: 1, agentId: "fixture", queries: {} }),
  );
  return {
    directory,
    manifest: { id: "fixture", sqlConfig: "sql.config.json", gea: { consumerCode: "fixture" } },
  };
}

test("a valid configured page on old Workbench requires completing its update and performs no SQL", async (t) => {
  const { readConfiguredHtmlQuery } = await subject(t, "src/host/configured-html-query.ts", {
    configured: "missing",
  });
  const resource = await configuredResource(t);
  const pluginSql = t.mock.fn(() => {
    throw Error("UNEXPECTED_SQL");
  });
  const result = await readConfiguredHtmlQuery(
    resource,
    { queryId: "sample", parameters: {} },
    { pluginSql },
    new AbortController().signal,
  );
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "GEA_WORKBENCH_UPDATE_REQUIRED");
  assert.match(result.message, /Workbench.*更新/);
  assert.equal(pluginSql.mock.callCount(), 0);
});

for (const configured of ["missing-package", "broken-dependency"])
  test(`configured-query retains ${configured} failures instead of claiming Workbench needs an update`, async (t) => {
    const { readConfiguredHtmlQuery } = await subject(t, "src/host/configured-html-query.ts", {
      configured,
    });
    const resource = await configuredResource(t);
    const pluginSql = t.mock.fn(() => {
      throw Error("UNEXPECTED_SQL");
    });
    const invalid = await readConfiguredHtmlQuery(
      resource,
      { queryId: "../invalid", parameters: {} },
      { pluginSql },
      new AbortController().signal,
    );
    assert.equal(invalid.errorCode, "INVALID_CONFIGURED_QUERY");
    await assert.rejects(
      readConfiguredHtmlQuery(
        resource,
        { queryId: "sample", parameters: {} },
        { pluginSql },
        new AbortController().signal,
      ),
      (error) =>
        error.message ===
        (configured === "missing-package"
          ? "CONFIGURED_PACKAGE_NOT_FOUND"
          : "CONFIGURED_DEPENDENCY_NOT_EXPORTED"),
    );
    assert.equal(pluginSql.mock.callCount(), 0);
  });
