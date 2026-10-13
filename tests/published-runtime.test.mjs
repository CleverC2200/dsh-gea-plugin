import test from "node:test";
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { businessDeploymentPatch, deploymentPatch } from "../scripts/deployment.mjs";
import { findSupportedCore, readSupportedCore, sdkVersion } from "../scripts/supported-cores.mjs";
const require = createRequire(import.meta.url);
test("fixed Core and workbench resolve while ordinary patches preserve the official layout", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const coreRoot = resolve(root, "../../official-latest-standard");
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const lock = parse(await readFile(resolve(root, "pnpm-lock.yaml"), "utf8"));
  const current = JSON.parse(await readFile(resolve(root, "scripts/current-core.json"), "utf8"));
  assert.equal(current.version, "0.2.1-alpha.1");
  assert.equal(current.upstream, "5badb15009ae1756c3afe0ae0cef1faafc290ccc");
  assert.ok(
    findSupportedCore({ head: current.adaptation, version: current.version }),
    "the default deployment adaptation must remain registered",
  );
  // The deployment default and the official CI axis have separate registered identities.
  const core = await readSupportedCore(coreRoot);
  assert.equal(core.id, undefined, "a private adaptation cannot pass as an official Core axis");
  assert.deepEqual(
    await readFile(resolve(coreRoot, "pnpm-lock.yaml")),
    execFileSync("git", ["-C", coreRoot, "show", core.head + ":pnpm-lock.yaml"]),
  );
  for (const [section, name, link, version] of [
    [
      "devDependencies",
      "@deepseek-ai/dsh",
      "link:../../official-latest-standard/apps/cli",
      sdkVersion(core, "@deepseek-ai/dsh"),
    ],
    [
      "devDependencies",
      "@deepseek-ai/dsh-client-ui-layout",
      "link:../../official-latest-standard/packages/client/ui-layout",
      sdkVersion(core, "@deepseek-ai/dsh-client-ui-layout"),
    ],
    ["dependencies", "@cleverc2200/dsh-agent-workbench", "link:../dsh-agent-workbench", "0.1.1"],
  ]) {
    assert.equal(manifest[section][name], link);
    assert.deepEqual(lock.importers["."][section][name], { specifier: link, version: link });
    const path = require.resolve(name + "/package.json");
    const installed = JSON.parse(await readFile(path, "utf8"));
    assert.equal(installed.name, name);
    assert.equal(installed.version, version);
    assert.equal(
      await realpath(path),
      await realpath(resolve(root, link.slice(5), "package.json")),
    );
  }
  const layout = await readFile(
    require.resolve("@deepseek-ai/dsh-client-ui-layout/client"),
    "utf8",
  );
  assert.equal(layout.includes("registerConversationPanel"), false);
  const patch = deploymentPatch({ analysis: { mode: "receipt" } }, "/plugin", "/runtime");
  assert.equal(
    patch.some((row) => row.id === "ui-layout"),
    false,
  );
  assert.equal(
    businessDeploymentPatch({ analysis: { mode: "receipt" } }, "/plugin", "/runtime").some(
      (row) => row.id === "ui-layout",
    ),
    false,
  );
  const workbench = patch
    .flatMap((row) => row.insert ?? [])
    .find((entry) => entry.id === "agent-workbench");
  assert.equal(workbench.name, require.resolve("@cleverc2200/dsh-agent-workbench"));
  assert.equal(
    await realpath(workbench.name),
    await realpath(
      resolve(
        dirname(require.resolve("@cleverc2200/dsh-agent-workbench/package.json")),
        "lib/host.js",
      ),
    ),
  );
  assert.ok(patch.some((row) => row.insert?.some((entry) => entry.id === "agent-workbench")));
  assert.equal(
    patch.some((row) => row.insert?.some((entry) => entry.id === "workbench-example")),
    false,
  );
});

test("GEA exposes a standard bundle that composes the independent workbench", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dsh.bundle?.patch, "./cordis.patch.yml");
  const { loadProfile } = await import("@deepseek-ai/dsh-app-boot");
  assert.equal(typeof loadProfile, "function");
});

test("missing and incompatible workbench dependencies fail with actionable diagnostics", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { resolveWorkbench } = await import("../scripts/deployment.mjs");
  const root = await mkdtemp(join(tmpdir(), "workbench-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => resolveWorkbench(join(root, "package.json")), /WORKBENCH_MISSING/);
  const dep = join(root, "node_modules/@cleverc2200/dsh-agent-workbench");
  await mkdir(dep, { recursive: true });
  await writeFile(
    join(dep, "package.json"),
    JSON.stringify({ name: "@cleverc2200/dsh-agent-workbench", version: "9.0.0" }),
  );
  assert.throws(() => resolveWorkbench(join(root, "package.json")), /WORKBENCH_INCOMPATIBLE/);
});

test("bundle overlays keep the data workspace independent of the installed version", () => {
  const patch = deploymentPatch({ analysis: { mode: "receipt" } }, "/version-b", "/user-data", {
    bundle: true,
  });
  assert.equal(
    patch.find((row) => row.id === "agent-workbench").config.cwd,
    "/user-data/workspace",
  );
  assert.equal(patch.find((row) => row.id === "gea-proof").config.runtimeDir, "/user-data");
  assert.equal(
    patch.some((row) => row.insert?.some((entry) => entry.id === "gea-proof")),
    false,
  );
});
