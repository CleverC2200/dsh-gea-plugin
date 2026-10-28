import test from "node:test";
import "./plugin-reception/readiness.test.mjs";
import "./plugin-reception/download-store.test.mjs";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiveDelivery } from "./plugin-reception.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { supportedCores, coreIdentity, sdkPeerRange, sdkVersion } from "./supported-cores.mjs";
import {
  artifactSetSha256,
  validateRuntimeObservation,
  bindReception,
  retainStandard,
  projectOrchestrationStandard,
} from "./plugin-reception/contract.mjs";
import {
  currentBusinessIds,
  validateInitialPresets,
} from "./plugin-reception/preset-discovery.mjs";

test("reception allows sibling outputs and rejects protected or overlapping paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reception-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = join(root, "core");
  const delivery = join(root, "delivery");
  await mkdir(core);
  await mkdir(delivery);
  const manifest = join(delivery, "manifest.json");
  const pnpm = join(root, "pnpm.mjs");
  await writeFile(manifest, "{}");
  await writeFile(pnpm, "process.stdout.write('');\n");
  const input = {
    manifest,
    core,
    pnpm,
    home: join(root, "home"),
    evidence: join(root, "evidence"),
  };
  await assert.rejects(receiveDelivery(input), /RECEPTION_STORE_ABSOLUTE_REQUIRED/);
  await assert.rejects(access(input.home), { code: "ENOENT" });
  await assert.rejects(access(input.evidence), { code: "ENOENT" });
  await assert.rejects(
    receiveDelivery({ ...input, home: join(core, "home") }),
    /RECEPTION_OUTPUT_IN_PROTECTED_INPUT/,
  );
  await mkdir(input.home);
  await assert.rejects(
    receiveDelivery({ ...input, evidence: join(input.home, "evidence") }),
    /RECEPTION_HOME_EVIDENCE_OVERLAP/,
  );
});

test("governed customer inventory, fulfillment and order workbench are discoverable before selection", () => {
  const presets = currentBusinessIds.map((id) => ({ id, broken: false }));
  validateInitialPresets(presets);
  for (const id of [
    "gea-html-inventory-customer",
    "gea-html-inventory-orderfulfillment",
    "gea-html-inventory-orderworkbench",
  ])
    for (const invalid of [
      presets.filter((row) => row.id !== id),
      presets.map((row) => (row.id === id ? { ...row, broken: true } : row)),
      [...presets, { id, broken: false }],
    ])
      assert.throws(
        () => validateInitialPresets(invalid),
        new RegExp(`BUSINESS_PRESET_NOT_DISCOVERABLE_BEFORE_SELECTION:${id}`),
      );
});

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`./fixtures/plugin-reception/${name}.json`, import.meta.url), "utf8"),
  );
test("actual first package candidate cannot pass with its missing APS resource", async () => {
  const runtime = await fixture("observe-02");
  assert.throws(
    () => validateRuntimeObservation(runtime),
    /RECEPTION_RESOURCE_NOT_READY:gea-html-inventory-apsplan/,
  );
});
test("actual first candidate sales resource cannot pass even after APS is supplied", async () => {
  const runtime = await fixture("observe-02");
  runtime.resources.push({
    id: "gea-html-inventory-apsplan",
    kind: "prompt",
    enabled: true,
    error: false,
    missingSkills: [],
  });
  assert.throws(
    () => validateRuntimeObservation(runtime),
    /RECEPTION_RESOURCE_NOT_READY:gea-readonly/,
  );
});
test("actual final candidate passes semantic checks, without inventing historical binding", async () => {
  const runtime = await fixture("observe-03");
  validateRuntimeObservation(runtime);
  assert.equal(runtime.artifactSetSha256, undefined);
  assert.throws(() => bindReception({}, {}, { observation: runtime }), /RECEPTION_BINDING_INVALID/);
});
test("artifact binding ignores paths but includes identities, versions and digests", () => {
  const set = [{ name: "x", version: "1", sha256: "a".repeat(64), file: "/private/one" }];
  assert.equal(artifactSetSha256(set), artifactSetSha256([{ ...set[0], file: "/private/two" }]));
  assert.notEqual(
    artifactSetSha256(set),
    artifactSetSha256([{ ...set[0], sha256: "b".repeat(64) }]),
  );
});
test("one bound receipt set passes; a different package, profile, or SDK closure fails", async () => {
  const runtime = await fixture("observe-03");
  const packages = runtime.plugins.map((row, i) => ({
    name: row.name,
    version: "1.0.0",
    sha256: String(i + 1).repeat(64),
  }));
  const setHash = artifactSetSha256(packages);
  const core = { head: "5badb15009ae1756c3afe0ae0cef1faafc290ccc", version: "0.2.1-alpha.1" };
  const manifest = {
    status: "packaged",
    core,
    supportedCores: supportedCores.map(coreIdentity),
    packages,
  };
  runtime.sdk.forEach((row) => {
    row.peerRange = sdkPeerRange(row.name);
  });
  const process = {
    code: 0,
    signal: null,
    timedOut: false,
    killSent: false,
    cleanupTimedOut: false,
    rawOutputPrivateOnly: true,
  };
  const scope = {
    nativeRun: false,
    credentialsReadOrCopied: false,
    modelTasks: 0,
    businessQueries: 0,
  };
  const install = {
    ...scope,
    success: true,
    mode: "install",
    installProcess: process,
    profile: "/owned/profile",
    core: "/fixed/core",
    coreHead: core.head,
    coreVersion: core.version,
    artifactSetSha256: setHash,
    artifacts: packages.map((row) => ({ ...row, byteEqual: true, files: 1 })),
  };
  const observe = {
    ...scope,
    success: true,
    mode: "observe",
    observationProcess: process,
    profile: install.profile,
    core: install.core,
    coreHead: core.head,
    coreVersion: core.version,
    observation: { ...runtime, artifactSetSha256: setHash },
  };
  const bindings = {
    expectedCore: install.core,
    expectedCoreIdentity: core,
    expectedProfile: install.profile,
    manifestSha256: "a".repeat(64),
    installSha256: "b".repeat(64),
    observeSha256: "c".repeat(64),
    packageManifests: packages.map((row) => ({
      name: row.name,
      peerDependencies: Object.fromEntries(
        runtime.sdk
          .filter((sdk) => sdk.plugin === row.name)
          .map((sdk) => [sdk.name, sdkPeerRange(sdk.name)]),
      ),
    })),
  };
  assert.equal(
    bindReception(manifest, install, observe, bindings).status,
    "installed-and-host-observed",
  );
  const rc2 = supportedCores.find((core) => core.version === "0.2.0-rc.2");
  const rcRuntime = {
    ...observe.observation,
    sdk: runtime.sdk.map((row) => ({ ...row, version: sdkVersion(rc2, row.name) })),
  };
  const rcInstall = { ...install, coreHead: rc2.head, coreVersion: rc2.version };
  const rcObserve = {
    ...observe,
    coreHead: rc2.head,
    coreVersion: rc2.version,
    observation: rcRuntime,
  };
  const rcAcceptance = bindReception(manifest, rcInstall, rcObserve, {
    ...bindings,
    expectedCoreIdentity: coreIdentity(rc2),
  });
  assert.deepEqual(rcAcceptance.core, coreIdentity(rc2));
  assert.deepEqual(rcAcceptance.buildCore, core);
  assert.equal(
    rcAcceptance.artifactSetSha256,
    bindReception(manifest, install, observe, bindings).artifactSetSha256,
  );
  assert.throws(
    () => bindReception(manifest, { ...rcInstall, coreVersion: core.version }, rcObserve, bindings),
    /RECEPTION_CORE_INVALID/,
  );
  assert.throws(
    () => bindReception(manifest, rcInstall, observe, bindings),
    /RECEPTION_PROFILE_CORE_MISMATCH/,
  );
  assert.throws(
    () => bindReception({ ...manifest, supportedCores: [core] }, install, observe, bindings),
    /RECEPTION_CORE_INVALID/,
  );
  for (const change of [
    { peerRange: "0.2.1-alpha.1" },
    { version: "0.2.1-alpha.2" },
    { peerSatisfied: false },
    { sameInstallationInstance: false },
  ]) {
    const badSdk = runtime.sdk.map((row, index) => (index === 0 ? { ...row, ...change } : row));
    assert.throws(
      () =>
        bindReception(
          manifest,
          install,
          { ...observe, observation: { ...observe.observation, sdk: badSdk } },
          bindings,
        ),
      /RECEPTION_SDK_/,
    );
  }
  assert.equal(
    bindReception(
      { ...manifest, status: "installed-and-host-observed" },
      install,
      observe,
      bindings,
    ).status,
    "installed-and-host-observed",
  );
  assert.throws(
    () => bindReception({ ...manifest, status: "ready" }, install, observe, bindings),
    /RECEPTION_BINDING_INVALID/,
  );
  assert.throws(
    () => bindReception(manifest, install, observe, { ...bindings, packageManifests: undefined }),
    /RECEPTION_DECLARED_SDK_REQUIRED/,
  );
  assert.throws(
    () =>
      bindReception(
        { ...manifest, core: { ...core, version: "0.2.0-rc.2" } },
        install,
        observe,
        bindings,
      ),
    /RECEPTION_CORE_INVALID/,
  );
  assert.throws(
    () => bindReception(manifest, install, { ...observe, profile: "/another/profile" }, bindings),
    /RECEPTION_PROFILE_CORE_MISMATCH/,
  );
  for (const value of [undefined, "", "relative/path"]) {
    assert.throws(
      () =>
        bindReception(
          manifest,
          { ...install, core: value, profile: value },
          { ...observe, core: value, profile: value },
          bindings,
        ),
      /RECEPTION_ABSOLUTE_BINDING_REQUIRED/,
    );
    assert.throws(
      () =>
        bindReception(manifest, install, observe, {
          ...bindings,
          expectedCore: value,
          expectedProfile: value,
        }),
      /RECEPTION_ABSOLUTE_BINDING_REQUIRED/,
    );
  }
  assert.throws(
    () =>
      bindReception(manifest, install, observe, {
        ...bindings,
        expectedProfile: "/another/profile",
      }),
    /RECEPTION_PROFILE_CORE_MISMATCH/,
  );
  assert.throws(
    () =>
      bindReception(
        manifest,
        install,
        { ...observe, observation: { ...observe.observation, artifactSetSha256: "f".repeat(64) } },
        bindings,
      ),
    /RECEPTION_ARTIFACT_BINDING_MISSING/,
  );
  assert.throws(
    () =>
      bindReception(
        manifest,
        install,
        { ...observe, observation: { ...observe.observation, sdk: runtime.sdk.slice(1) } },
        bindings,
      ),
    /RECEPTION_SDK_INCOMPLETE/,
  );
  assert.throws(
    () => bindReception(manifest, { ...install, success: false }, observe, bindings),
    /RECEPTION_RECEIPT_FAILED/,
  );
  for (const field of ["timedOut", "killSent", "cleanupTimedOut"])
    assert.throws(
      () =>
        bindReception(
          manifest,
          install,
          { ...observe, observationProcess: { ...process, [field]: true } },
          bindings,
        ),
      /RECEPTION_PROCESS_UNSAFE/,
    );
  assert.throws(
    () => bindReception(manifest, { ...install, installProcess: undefined }, observe, bindings),
    /RECEPTION_PROCESS_UNSAFE/,
  );
  assert.throws(
    () => bindReception(manifest, install, { ...observe, credentialsReadOrCopied: true }, bindings),
    /RECEPTION_SCOPE_CHANGED/,
  );
});
test("public CLI rejects relative inputs without echoing token text or starting installation", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./plugin-reception.mjs", import.meta.url)),
      "--manifest",
      "relative?token=do-not-echo",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^RECEPTION_ABSOLUTE_INPUT_REQUIRED\s*$/);
  assert.equal(result.stdout, "");
  assert(!result.stderr.includes("do-not-echo"));
});

test("company preset reception accepts the approved persona projection and still requires standard capabilities", async () => {
  const runtime = await fixture("observe-03");
  for (const doc of runtime.documents)
    if (["auto-negotiation", "agent-resource-skill"].includes(doc.id))
      doc.byteEqualStandard = false;
  validateRuntimeObservation(runtime);
  runtime.documents.find((doc) => doc.id === "auto-negotiation").fullStandardRetained = false;
  assert.throws(() => validateRuntimeObservation(runtime), /RECEPTION_STANDARD_INCOMPLETE/);
});

test("company capability retention accepts a persona prefix but rejects missing tools and changed compaction", () => {
  const baseline = [
    {
      name: "@deepseek-ai/dsh-persona",
      config: {
        prefix: "minimal",
        suffix: "",
        complete: true,
        includeRuntimeContext: false,
      },
    },
    { name: "@deepseek-ai/dsh-tools", config: { enabled: true } },
    { name: "@deepseek-ai/dsh-compaction", config: { enabled: true } },
  ];
  const actual = structuredClone(baseline);
  actual[0].config.prefix += "\n\nUser role";
  const additions = [];
  retainStandard(baseline, actual, "business", additions);
  assert.deepEqual(additions, ["/@deepseek-ai/dsh-persona"]);
  assert.throws(
    () =>
      retainStandard(
        baseline,
        actual.filter((row) => row.name !== "@deepseek-ai/dsh-tools"),
        "business",
        [],
      ),
    /STANDARD_ENTRY_LOST_OR_DUPLICATED/,
  );
  const changed = structuredClone(actual);
  changed[2].config.enabled = false;
  assert.throws(
    () => retainStandard(baseline, changed, "business", []),
    /STANDARD_ENTRY_CONFIG_CHANGED/,
  );
});

test("orchestration reception follows packaged declarations across unmanaged and configured resources", () => {
  const baseline = [
    {
      id: "persona",
      name: "@deepseek-ai/dsh-persona",
      config: { prefix: "Standard", suffix: "", complete: true },
    },
    { id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem" },
    { id: "tools", name: "standard-tools" },
  ];
  const input = { prompt: "COO prompt", skillDirectory: "/fixed/skills" };
  const skillConfig = { skills: [{ name: "declared-skill", enabled: true }], inheritSkills: true };
  const managed = projectOrchestrationStandard(baseline, { ...input, managed: true, skillConfig });
  assert.deepEqual(managed[0].config, {
    prefix: "Standard\n\nCOO prompt",
    suffix: "",
    complete: true,
  });
  assert.deepEqual(managed.slice(1, -1), baseline.slice(1));
  assert.deepEqual(managed.at(-1), {
    id: "user-agent-skills",
    name: "dsh-agent-manage/user-agent-skills",
    config: skillConfig,
  });
  assert.throws(
    () => projectOrchestrationStandard(baseline, { ...input, managed: true }),
    /ORCHESTRATION_SKILL_DECLARATION_REQUIRED/,
  );
  const filesystem = projectOrchestrationStandard(baseline, { ...input, managed: false });
  assert.deepEqual(filesystem[1].config, {
    customSkillDirs: [input.skillDirectory + (process.platform === "win32" ? "\\" : "/")],
  });
  assert.deepEqual(projectOrchestrationStandard(baseline, { managed: false }), baseline);
  assert.throws(
    () => projectOrchestrationStandard(baseline, { managed: true }),
    /ORCHESTRATION_PROMPT_REQUIRED/,
  );
  assert.throws(
    () => projectOrchestrationStandard(baseline, { ...input, prompt: " ", managed: true }),
    /ORCHESTRATION_PROMPT_REQUIRED/,
  );
  assert.equal(baseline[0].config.prefix, "Standard");
});
