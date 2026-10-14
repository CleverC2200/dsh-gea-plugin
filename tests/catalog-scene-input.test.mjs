import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { assertCatalogSceneOwners, assertCatalogSceneSources } from "./fixtures/catalog-scene.mjs";
import { sourceAssemblyFixture } from "./fixtures/source-assembly.mjs";
import { sourcePlugins } from "../scripts/source-composition.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/catalog-scene-expectations.json", import.meta.url), "utf8"),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ownersFor = (workbench, manage) => ({
  "@cleverc2200/dsh-agent-workbench": { commit: workbench },
  "dsh-agent-manage": { commit: manage },
  "@changfenhuang/dsh-genui": { commit: fixture.requiredPeers["dsh-genui"] },
  "dsh-better-sidebar": { commit: fixture.requiredPeers["dsh-better-sidebar"] },
});
test("catalog owners follow the admitted source-event, joint and post-merge tuples exactly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gea-catalog-peer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "candidate.json");
  for (const [w, m, g] of [
    ["a", "b", "c"],
    ["d", "e", "f"],
    ["1", "2", "3"],
  ]) {
    const manifest = {
      core: fixture.coreHeads.alpha,
      repositories: [
        { repo: "dsh-agent-workbench", head: w.repeat(40), path: "/declared/workbench" },
        { repo: "dsh-agent-manage", head: m.repeat(40), path: "/declared/manage" },
        { repo: "dsh-gea-plugin", head: g.repeat(40), path: "/declared/gea" },
      ],
    };
    const bytes = JSON.stringify(manifest) + "\n";
    await writeFile(input, bytes);
    const options = { input, sha256: digest(bytes) };
    await assertCatalogSceneOwners(ownersFor(w.repeat(40), m.repeat(40)), options);
    await assert.rejects(
      assertCatalogSceneOwners(ownersFor("0".repeat(40), m.repeat(40)), options),
      /workbench scene input/,
    );
    await assert.rejects(
      assertCatalogSceneOwners(ownersFor(w.repeat(40), "0".repeat(40)), options),
      /manage scene input/,
    );
    const foreign = ownersFor(w.repeat(40), m.repeat(40));
    foreign["@changfenhuang/dsh-genui"].commit = "0".repeat(40);
    await assert.rejects(assertCatalogSceneOwners(foreign, options), /genui scene input/);
    await writeFile(input, bytes + " ");
    await assert.rejects(
      assertCatalogSceneOwners(ownersFor(w.repeat(40), m.repeat(40)), options),
      /catalog candidate original bytes/,
    );
  }
});
test("catalog admission refuses partial, mutable, duplicated and forged candidate source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gea-catalog-peer-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "candidate.json");
  const repositories = ["dsh-agent-workbench", "dsh-agent-manage", "dsh-gea-plugin"].map(
    (repo, i) => ({ repo, head: String(i + 1).repeat(40), path: "/declared/" + repo }),
  );
  for (const entries of [
    repositories.slice(1),
    [repositories[0], repositories[0], repositories[2]],
    repositories.map((entry, i) => (i === 0 ? { ...entry, head: "main" } : entry)),
    repositories.map((entry, i) => (i === 0 ? { ...entry, head: "a".repeat(40) + "\n" } : entry)),
    repositories.map((entry, i) => (i === 0 ? { ...entry, repo: "foreign/repo" } : entry)),
  ]) {
    const bytes = JSON.stringify({ core: fixture.coreHeads.alpha, repositories: entries });
    await writeFile(input, bytes);
    await assert.rejects(
      assertCatalogSceneOwners(ownersFor("1".repeat(40), "2".repeat(40)), {
        input,
        sha256: digest(bytes),
      }),
      /catalog candidate registered tuple/,
    );
  }
  await assert.rejects(
    assertCatalogSceneOwners(ownersFor("1".repeat(40), "2".repeat(40)), { input }),
    /catalog candidate original hash required/,
  );
  await assert.rejects(
    assertCatalogSceneOwners(ownersFor("1".repeat(40), "2".repeat(40)), { sha256: "a".repeat(64) }),
    /catalog candidate original hash required/,
  );
});
test("unbound catalog keeps the independent fixed owners and refuses new peers", async () => {
  await assertCatalogSceneOwners(
    ownersFor(
      fixture.requiredPeers["dsh-agent-workbench"],
      fixture.requiredPeers["dsh-agent-manage"],
    ),
    {},
  );
  await assert.rejects(
    assertCatalogSceneOwners(ownersFor("a".repeat(40), "b".repeat(40)), {}),
    /workbench scene input/,
  );
});

test("a changed installed Skill body remains rejected before catalog metadata is accepted", async () => {
  await assert.rejects(
    assertCatalogSceneSources(async () => Buffer.from("changed Skill body\n")),
    /workbench Skill source lib\/static\/category\/skills\/category-plan\/SKILL.md/,
  );
});

test("catalog owners follow all five explicitly admitted source records and reject another optional source", async (t) => {
  const { root, sources } = await sourceAssemblyFixture(t);
  const sourcesFile = join(root, "sources.json");
  await writeFile(sourcesFile, JSON.stringify(sources));
  const input = join(root, "candidate.json");
  const bytes = JSON.stringify({
    repositories: sources
      .slice(0, 3)
      .map((row) => ({ repo: row.repo, head: row.commit, path: row.source })),
  });
  await writeFile(input, bytes);
  const options = { input, sha256: digest(bytes), sourcesFile };
  const owners = Object.fromEntries(
    sources.map((row) => [
      sourcePlugins.find((plugin) => plugin.repo === row.repo).name,
      { commit: row.commit },
    ]),
  );
  await assertCatalogSceneOwners(owners, options);
  for (const name of [
    "@changfenhuang/dsh-genui",
    "dsh-better-sidebar",
    "@cleverc2200/gea-dsh-prototype",
  ]) {
    const foreign = structuredClone(owners);
    foreign[name].commit = "0".repeat(40);
    await assert.rejects(assertCatalogSceneOwners(foreign, options), /scene input/);
  }
  sources[3].commit = "0".repeat(40);
  await writeFile(sourcesFile, JSON.stringify(sources));
  await assert.rejects(assertCatalogSceneOwners(owners, options), /SOURCE_PLUGIN_COMMIT_MISMATCH/);
});
