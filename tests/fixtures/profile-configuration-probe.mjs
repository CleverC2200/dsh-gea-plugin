/** Execute the original fixture up to deployment admission without starting a Host or browser. */
import { registerHooks } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readDeployment } from "../../scripts/deployment.mjs";
import assert from "node:assert/strict";

const [file, name, directory, mode = "credentials"] = process.argv.slice(2);
const deploymentModule = new URL("../../scripts/deployment.mjs", import.meta.url).href;
const run = promisify(execFile);
const hooks = [];
const cases = [];
const receipt = { browserStarts: 0, hostStarts: 0, browserClosed: 0 };
let configurationWritten = false;
const completed = new Error("PROBE_ADMISSION_COMPLETE");
const earlyFailure = new Error("PROBE_BEFORE_UI_TRY");
const fakeKeys = [
  "GEA_TEST_MODEL_KEY",
  "GEA_BUDGET_TEST_KEY",
  "GEA_QA_MODEL_KEY",
  "V2_TEST_MODEL_KEY",
  "GEA_V16_MODEL_KEY",
  "GEA_GENUI_TEST_KEY",
  "GEA_PICKER_TEST_KEY",
  "GEA_THEME_TEST_KEY",
  "GEA_SPLIT_TEST_KEY",
];
for (const key of fakeKeys) delete process.env[key];
const previousKey = mode === "existing-parent" ? "previous-fixture-key" : undefined;
if (previousKey) process.env.GEA_TEST_MODEL_KEY = previousKey;
const parentBefore = Object.fromEntries(fakeKeys.map((key) => [key, process.env[key]]));
globalThis.fixtureCase = (title, options, fn) =>
  cases.push({ title, options: fn ? options : {}, fn: fn ?? options });
globalThis.fixtureBrowser = {
  async launch() {
    return {
      async close() {
        receipt.browserClosed++;
      },
      async newContext() {
        return {
          async addCookies() {},
          async newPage() {
            return {
              on() {},
              async goto() {
                throw earlyFailure;
              },
            };
          },
        };
      },
    };
  },
};
globalThis.fixtureProfile = async (_t, options = {}) => {
  if (mode === "early-ui-failure")
    return {
      origin: "http://127.0.0.1:1",
      cookie: "fixture=1",
      route() {},
      async login() {},
      async stop() {},
    };
  const config = resolve(directory, "deployment.json");
  await writeFile(
    config,
    JSON.stringify({
      geaBaseUrl: "https://127.0.0.1:1/gea",
      pageSize: 10,
      periodPageSize: 100,
      requestTimeoutMs: 2000,
      maxSnapshotBytes: 100000,
      analysis: { mode: "receipt" },
      ...options.config("https://127.0.0.1:1"),
    }),
  );
  configurationWritten = true;
  const keyName = JSON.parse(await readFile(config, "utf8")).analysis.apiKeyEnv;
  const keyValue = options.env[keyName];
  receipt.declaredFakeKey =
    fakeKeys.includes(keyName) && typeof keyValue === "string" && keyValue.length > 0;
  if (mode === "missing-parent") {
    const parentEnv = { ...options.env };
    delete parentEnv[keyName];
    await assert.rejects(
      readDeployment(config, { resolveCredentials: false, credentialEnv: parentEnv }),
      /ANALYSIS_CREDENTIAL_MISSING/,
    );
    receipt.missingRejected = true;
    throw completed;
  }
  await readDeployment(config, { resolveCredentials: false, credentialEnv: options.env });
  receipt.parentAdmitted = true;
  const child = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { readDeployment } from ${JSON.stringify(deploymentModule)};
    await readDeployment(process.argv[1], { resolveCredentials: false });
    console.log(JSON.stringify({ admitted: process.env[${JSON.stringify(keyName)}] === ${JSON.stringify(keyValue)} }));
  `,
      config,
    ],
    { env: { ...process.env, ...options.env } },
  );
  receipt.childAdmitted = JSON.parse(child.stdout).admitted;
  throw completed;
};
const moduleUrl = (code) => "data:text/javascript," + encodeURIComponent(code);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:test")
      return { url: moduleUrl("export default globalThis.fixtureCase;"), shortCircuit: true };
    if (specifier === "@playwright/test")
      return {
        url: moduleUrl("export const chromium=globalThis.fixtureBrowser; export const expect={};"),
        shortCircuit: true,
      };
    const result = next(specifier, context);
    if (result.url === new URL("../profile.mjs", import.meta.url).href)
      return {
        url: moduleUrl(
          "export const profile=globalThis.fixtureProfile; export const readSession=()=>{}; export const readToolResults=()=>{}; export const until=()=>{};",
        ),
        shortCircuit: true,
      };
    return result;
  },
});
await import(pathToFileURL(resolve(file)).href);
const selected = cases.find((entry) => entry.title === name);
if (!selected) throw Error("PROBE_FIXTURE_CASE_MISSING");
try {
  await selected.fn({
    signal: selected.options.signal ?? new AbortController().signal,
    after(fn) {
      hooks.push(fn);
    },
  });
} catch (error) {
  receipt.error = error.message;
  receipt.expectedBoundary = error === (mode === "early-ui-failure" ? earlyFailure : completed);
} finally {
  for (const hook of hooks) await hook();
}
receipt.parentRestored = fakeKeys.every((key) => process.env[key] === parentBefore[key]);
receipt.config =
  configurationWritten
    ? JSON.parse(await readFile(resolve(directory, "deployment.json"), "utf8"))
    : undefined;
console.log(JSON.stringify(receipt));
