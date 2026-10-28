import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { productionManifest } from "../scripts/production-manifest.mjs";
import {
  validatePluginCombination,
  planPluginUpdate,
  planPluginSuiteUpdate,
  projectPluginRelease,
} from "../src/shared/plugin-release.mjs";
const W = "@cleverc2200/dsh-agent-workbench",
  M = "dsh-agent-manage",
  G = "@cleverc2200/gea-dsh-prototype";
const core = {
  head: "a".repeat(40),
  version: "0.2.0-rc.2",
  sdk: { "@deepseek-ai/dsh-tools": "0.2.0-rc.2" },
};
const graph = [
  { name: W, version: "1.0.0" },
  { name: M, version: "2.0.0" },
  {
    name: G,
    version: "3.0.0",
    peerDependencies: { [W]: "1.0.0", [M]: "2.0.0" },
  },
];
test("single-package update validates existing consumers and permits independently compatible versions", () => {
  assert.deepEqual(validatePluginCombination({ core, manifests: graph }), []);
  assert.equal(
    validatePluginCombination({
      core,
      manifests: graph.map((m) => (m.name === W ? { ...m, version: "1.1.0" } : m)),
    })[0].code,
    "PEER_INCOMPATIBLE",
  );
  assert.deepEqual(
    validatePluginCombination({
      core,
      manifests: graph.map((m) => (m.name === G ? { ...m, version: "3.1.0" } : m)),
    }),
    [],
  );
});
const artifact = {
  url: `https://fixture.invalid/releases/${"b".repeat(64)}/gea.tgz`,
  size: 100,
  sha256: "b".repeat(64),
};
const release = () =>
  projectPluginRelease({
    manifest: { ...graph[2], version: "3.1.0" },
    artifact,
    supportedCores: [core],
    dataCompatibility: { kind: "preserve" },
    notes: "Fix",
  });
test("suite planning upgrades mutually dependent old versions without intermediate mixtures", () => {
  const releases = graph.map((manifest, index) =>
    projectPluginRelease({
      manifest: {
        ...manifest,
        version: ["1.1.0", "2.1.0", "3.1.0"][index],
        peerDependencies: { [W]: "1.1.0", [M]: "2.1.0", [G]: "3.1.0" },
      },
      artifact,
      supportedCores: [core],
      dataCompatibility: { kind: "preserve" },
      notes: "suite",
    }),
  );
  assert.ok(
    releases.every(
      (release) => planPluginUpdate({ release, core, installed: graph }).kind === "blocked",
    ),
  );
  const plan = planPluginSuiteUpdate({ releases, core, installed: graph });
  assert.equal(plan.kind, "ready");
  assert.deepEqual(plan.releases, releases);
  const installed = releases.map((r) => ({
    ...r,
    artifactSha256: r.artifact.sha256,
  }));
  assert.equal(planPluginSuiteUpdate({ releases, core, installed }).kind, "current");
  assert.equal(
    planPluginSuiteUpdate({
      releases: releases.slice(1),
      core,
      installed: graph,
    }).code,
    "RELEASE_NOT_PUBLISHED",
  );
  assert.equal(
    planPluginSuiteUpdate({
      releases: [releases[0], releases[0], releases[2]],
      core,
      installed: graph,
    }).code,
    "RELEASE_NOT_PUBLISHED",
  );
  assert.equal(
    planPluginSuiteUpdate({
      releases,
      core,
      installed: [
        ...graph,
        {
          name: "consumer",
          version: "1.0.0",
          peerDependencies: { [W]: "1.0.0" },
        },
      ],
    }).code,
    "COMBINATION_INCOMPATIBLE",
  );
  for (const [change, code] of [
    [{ version: "2.9.0" }, "DOWNGRADE_FORBIDDEN"],
    [{ supportedCores: [] }, "CORE_UNSUPPORTED"],
    [
      {
        dataCompatibility: {
          kind: "migration-required",
          note: "manual migration",
        },
      },
      "DATA_MIGRATION_REQUIRED",
    ],
  ]) {
    assert.equal(
      planPluginSuiteUpdate({
        releases: releases.map((r) => (r.name === G ? { ...r, ...change } : r)),
        core,
        installed: graph,
      }).code,
      code,
    );
  }
});
test("release projection keeps final manifest peers and fixed Core identity; plan prevents downgrade and replacement", () => {
  const r = release();
  assert.deepEqual(r.requires, { [W]: "1.0.0", [M]: "2.0.0" });
  assert.deepEqual(r.supportedCores, [{ head: core.head, version: core.version }]);
  assert.equal(planPluginUpdate({ release: r, core, installed: graph }).kind, "ready");
  assert.equal(
    planPluginUpdate({
      release: r,
      core: { ...core, head: "c".repeat(40) },
      installed: graph,
    }).code,
    "CORE_UNSUPPORTED",
  );
  assert.equal(
    planPluginUpdate({
      release: { ...r, version: "2.9.0" },
      core,
      installed: graph,
    }).code,
    "DOWNGRADE_FORBIDDEN",
  );
  assert.equal(
    planPluginUpdate({
      release: { ...r, version: "3.0.0" },
      core,
      installed: graph.map((m) => ({ ...m, artifactSha256: "c".repeat(64) })),
    }).code,
    "SAME_VERSION_CONTENT_MISMATCH",
  );
  assert.equal(
    planPluginUpdate({
      release: {
        ...r,
        dataCompatibility: {
          kind: "migration-required",
          note: "one-time migration",
        },
      },
      core,
      installed: graph,
    }).code,
    "DATA_MIGRATION_REQUIRED",
  );
});
test("optional installed peers are checked and unrelated installed consumers block breaking updates", () => {
  const releaseCandidate = release();
  const consumer = {
    name: "customer-dashboard",
    version: "1.0.0",
    peerDependencies: { [G]: "3.0.0" },
  };
  assert.equal(
    planPluginUpdate({
      release: releaseCandidate,
      core,
      installed: [...graph, consumer],
    }).code,
    "COMBINATION_INCOMPATIBLE",
  );
  assert.equal(
    validatePluginCombination({
      core,
      manifests: [
        {
          name: G,
          version: "3.0.0",
          peerDependencies: { "optional-renderer": "^2" },
          peerDependenciesMeta: { "optional-renderer": { optional: true } },
        },
      ],
    }).length,
    0,
  );
  assert.equal(
    validatePluginCombination({
      core,
      manifests: [
        {
          name: G,
          version: "3.0.0",
          peerDependencies: { "optional-renderer": "^2" },
          peerDependenciesMeta: { "optional-renderer": { optional: true } },
        },
        { name: "optional-renderer", version: "1.0.0" },
      ],
    })[0].code,
    "PEER_INCOMPATIBLE",
  );
});
test("independent channel projection retains the other two references and advances revision", async () => {
  const { mergePluginChannelRelease } = await import("../src/shared/plugin-release.mjs");
  const previous = {
    schema: 1,
    channel: "test",
    revision: 1,
    issuedAt: "2026-10-14T01:00:00.000Z",
    expiresAt: "2026-10-15T01:00:00.000Z",
    releases: [W, M, G].map((name, index) => ({
      name,
      url: `https://fixture.invalid/${String(index).repeat(64)}/release.json`,
      sha256: String(index).repeat(64),
    })),
  };
  const selected = {
    ...previous.releases[1],
    sha256: "d".repeat(64),
    url: `https://fixture.invalid/${"d".repeat(64)}/release.json`,
  };
  const next = mergePluginChannelRelease({
    previous,
    release: selected,
    revision: 2,
    issuedAt: previous.issuedAt,
    expiresAt: previous.expiresAt,
  });
  assert.deepEqual(next.releases, [previous.releases[0], selected, previous.releases[2]]);
  assert.throws(
    () =>
      mergePluginChannelRelease({
        previous,
        release: selected,
        revision: 1,
        issuedAt: previous.issuedAt,
        expiresAt: previous.expiresAt,
      }),
    /CHANNEL_REVISION_REQUIRED/,
  );
});

test("historical companion upgrades require an explicit declaration and preserve its boundary", async () => {
  const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const [name, previous, added, undeclared] of [
    [W, ["0.1.9", "0.1.10"], "0.1.11", "0.1.12"],
    [
      M,
      ["0.6.3-company.16", "0.6.3-company.17", "0.6.3-company.18", "0.6.3-company.19"],
      "0.6.3-company.20",
      "0.6.3-company.21",
    ],
  ]) {
    const issues = (declared, version) => {
      const range = declared.join(" || ");
      const manifest = productionManifest(
        {
          ...source,
          peerDependencies: { ...source.peerDependencies, [name]: range },
        },
        {
          [W]: "0.1.10",
          [M]: "0.6.3-company.19",
          "@changfenhuang/dsh-genui": "0.11.3",
          "dsh-better-sidebar": "0.24.1",
        },
      );
      assert.equal(manifest.peerDependencies[name], range);
      return validatePluginCombination({
        core,
        manifests: [
          { name, version },
          {
            name: G,
            version: manifest.version,
            peerDependencies: { [name]: manifest.peerDependencies[name] },
          },
        ],
      });
    };
    assert.ok(issues(previous, added).some((issue) => issue.code === "PEER_INCOMPATIBLE"));
    for (const version of [...previous, added])
      assert.deepEqual(issues([...previous, added], version), []);
    assert.ok(
      issues([...previous, added], undeclared).some((issue) => issue.code === "PEER_INCOMPATIBLE"),
    );
  }
});

test("company-peer update plans allow GEA first to bridge Workbench .9 to .10 and Manage .18 to .19", async () => {
  const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = productionManifest(
    {
      ...source,
      peerDependencies: {
        ...source.peerDependencies,
        [W]: "0.1.9 || 0.1.10",
        [M]: "0.6.3-company.16 || 0.6.3-company.17 || 0.6.3-company.18 || 0.6.3-company.19",
      },
    },
    {
      [W]: "0.1.10",
      [M]: "0.6.3-company.19",
      "@changfenhuang/dsh-genui": "0.11.3",
      "dsh-better-sidebar": "0.24.1",
    },
  );
  const nextGea = {
    name: G,
    version: manifest.version,
    peerDependencies: Object.fromEntries(
      Object.entries(manifest.peerDependencies).filter(([name]) => [W, M, G].includes(name)),
    ),
  };
  const installed = [
    { name: W, version: "0.1.9" },
    { name: M, version: "0.6.3-company.18" },
    {
      name: G,
      version: "0.0.162",
      peerDependencies: {
        [W]: "0.1.9",
        [M]: "0.6.3-company.16 || 0.6.3-company.17 || 0.6.3-company.18",
      },
    },
  ];
  const project = (manifest) =>
    projectPluginRelease({
      manifest,
      artifact,
      supportedCores: [core],
      dataCompatibility: { kind: "preserve" },
      notes: "Company-peer-only upgrade fixture",
    });
  const nextWorkbench = { name: W, version: "0.1.10" };
  const nextManage = { name: M, version: "0.6.3-company.19" };
  assert.equal(
    planPluginUpdate({ release: project(nextWorkbench), core, installed }).code,
    "COMBINATION_INCOMPATIBLE",
  );
  assert.equal(planPluginUpdate({ release: project(nextGea), core, installed }).kind, "ready");
  const afterGea = installed.map((entry) => (entry.name === G ? nextGea : entry));
  assert.equal(
    planPluginUpdate({
      release: project(nextWorkbench),
      core,
      installed: afterGea,
    }).kind,
    "ready",
  );
  const afterWorkbench = afterGea.map((entry) => (entry.name === W ? nextWorkbench : entry));
  assert.equal(
    planPluginUpdate({
      release: project(nextManage),
      core,
      installed: afterWorkbench,
    }).kind,
    "ready",
  );
});

test("a partial channel adds an independently published package without replacing existing references", async () => {
  const { mergePluginChannelRelease } = await import("../src/shared/plugin-release.mjs");
  const reference = (name) => ({
    name,
    sha256: "a".repeat(64),
    url: `https://fixture.invalid/${"a".repeat(64)}/release.json`,
  });
  const previous = {
    schema: 1,
    channel: "test",
    revision: 1,
    issuedAt: "2026-10-15T01:00:00.000Z",
    expiresAt: "2026-10-16T01:00:00.000Z",
    releases: [reference(G)],
  };
  const next = mergePluginChannelRelease({
    previous,
    release: reference(W),
    revision: 2,
    issuedAt: previous.issuedAt,
    expiresAt: previous.expiresAt,
  });
  assert.deepEqual(next.releases, [reference(G), reference(W)]);
});

test("schema1 bridge keeps GEA visible to legacy readers and companion references through merge and encoding", async () => {
  const { parsePluginChannel, mergePluginChannelRelease } =
    await import("../src/shared/plugin-release.mjs");
  const { encodePluginChannel } = await import("../scripts/plugin-channel.mjs");
  const reference = (name, sha256) => ({
    name,
    sha256,
    url: `https://fixture.invalid/${sha256}/release.json`,
  });
  const previous = {
    schema: 1,
    channel: "test",
    revision: 1,
    issuedAt: "2026-10-20T01:00:00.000Z",
    expiresAt: "2026-10-21T01:00:00.000Z",
    releases: [reference(G, "a".repeat(64))],
    companionReleases: [reference(W, "b".repeat(64)), reference(M, "c".repeat(64))],
  };
  assert.deepEqual(parsePluginChannel(previous), previous);
  const selected = reference(W, "d".repeat(64));
  const next = mergePluginChannelRelease({
    previous,
    release: selected,
    revision: 2,
    issuedAt: previous.issuedAt,
    expiresAt: previous.expiresAt,
  });
  assert.deepEqual(next.releases, previous.releases);
  assert.deepEqual(next.companionReleases, [selected, previous.companionReleases[1]]);
  const envelope = encodePluginChannel({
    payload: next,
  });
  const raw = Buffer.from(envelope.payloadBase64, "base64");
  assert.deepEqual(Object.keys(envelope), ["payloadBase64"]);
  assert.deepEqual(JSON.parse(raw), next);
  for (const change of [
    (p) => {
      p.companionReleases.push(p.releases[0]);
    },
    (p) => {
      p.companionReleases = [p.companionReleases[0], p.companionReleases[0]];
    },
    (p) => {
      p.companionReleases[0].url = "https://external.invalid/releases.json";
    },
    (p) => {
      p.releases.push(p.companionReleases.pop());
    },
  ]) {
    const invalid = structuredClone(previous);
    change(invalid);
    assert.throws(() => parsePluginChannel(invalid));
  }
});

test("incompatible installed consumer retains its real long semver diagnostic and remains blocked", async () => {
  const { planUpdateProblem, parseUpdateProblem } =
    await import("../src/shared/plugin-update-diagnostics.ts");
  const required =
    "0.1.9 || 0.1.10 || 0.1.11 || 0.1.12 || 0.1.13-sales.1 || 0.1.14-sales.1 || 0.1.15-sales.1 || 0.1.16-sales.1 || 0.1.16-resubmit.1 || 0.1.16-resubmit.2 || 0.1.16-resubmit.3";
  const installed = [
    { name: W, version: "0.1.16-resubmit.3" },
    {
      name: G,
      version: "0.0.171-resubmit.4",
      peerDependencies: { [W]: required },
    },
  ];
  const next = projectPluginRelease({
    manifest: { name: W, version: "0.1.17" },
    artifact,
    supportedCores: [core],
    dataCompatibility: { kind: "preserve" },
    notes: "Bridge diagnostic",
  });
  const plan = planPluginUpdate({ release: next, core, installed });
  assert.equal(plan.kind, "blocked");
  assert.equal(plan.code, "COMBINATION_INCOMPATIBLE");
  const problem = planUpdateProblem(plan, next, core, installed);
  assert.equal(problem.requirements[0].required, required);
  assert.equal(problem.requirements[0].current, "0.1.16-resubmit.3");
  assert.equal(problem.requirements[0].candidate, "0.1.17");
  assert.deepEqual(parseUpdateProblem(problem), problem);
  for (const mutate of [
    (p) => {
      p.requirements[0].required = "not a semver range";
    },
    (p) => {
      p.requirements[0].required = "1.0.0 || ".repeat(600) + "1.0.0";
    },
    (p) => {
      p.requirements[0].consumer = "a".repeat(161);
    },
    (p) => {
      p.requirements[0].installed = "1.0.0+" + "a".repeat(160);
    },
  ]) {
    const invalid = structuredClone(problem);
    mutate(invalid);
    assert.throws(() => parseUpdateProblem(invalid), /UPDATE_STATUS_INVALID/);
  }
});
