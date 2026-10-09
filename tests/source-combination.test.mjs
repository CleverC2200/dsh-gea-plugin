import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  readSourceCombination,
  selectSourceCombination,
  upgradeSourceProfileLayout,
} from "../scripts/source-profile.mjs";

test("selection rejects changed resources and a running Host, preserving the last selected combination", async (t) => {
  const runtime = await realpath(
    await mkdtemp(join(tmpdir(), "source-combination-")),
  );
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const id = randomUUID(),
    dir = join(runtime, "source-combinations", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "page.html"), "current page");
  await writeFile(
    join(dir, "combination.json"),
    JSON.stringify({
      composition: { id, dependencies: {} },
      externalFiles: {},
      externalRoots: [],
      externalLockFiles: [],
      files: {
        "page.html": createHash("sha256").update("current page").digest("hex"),
      },
    }),
  );
  await selectSourceCombination(runtime, id);
  const selected = await readFile(
    join(runtime, "source-selection.json"),
    "utf8",
  );
  await writeFile(join(runtime, "source-profile.lock"), "Host running");
  await assert.rejects(selectSourceCombination(runtime, id), {
    code: "EEXIST",
  });
  await rm(join(runtime, "source-profile.lock"));
  await writeFile(join(dir, "page.html"), "changed page");
  await assert.rejects(readSourceCombination(runtime, id), /DIGEST_MISMATCH/);
  await assert.rejects(selectSourceCombination(runtime, id), /DIGEST_MISMATCH/);
  assert.equal(
    await readFile(join(runtime, "source-selection.json"), "utf8"),
    selected,
  );
  await assert.rejects(
    readSourceCombination(runtime, "../../outside"),
    /INVALID_SOURCE_COMBINATION/,
  );
});

test("same source revision with changed dependency bytes refuses recovery", async (t) => {
  const runtime = await realpath(
    await mkdtemp(join(tmpdir(), "source-dependency-")),
  );
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const id = randomUUID(),
    directory = join(runtime, "source-combinations", id),
    dependency = join(runtime, "dependency/core.js");
  await mkdir(directory, { recursive: true });
  await mkdir(join(runtime, "dependency"), { recursive: true });
  await writeFile(dependency, "built core A");
  await writeFile(
    join(directory, "combination.json"),
    JSON.stringify({
      composition: { id, dependencies: {} },
      files: {},
      externalRoots: [join(runtime, "dependency")],
      externalLockFiles: [],
      externalFiles: {
        [dependency]: createHash("sha256").update("built core A").digest("hex"),
      },
    }),
  );
  await selectSourceCombination(runtime, id);
  await writeFile(dependency, "built core B");
  await assert.rejects(
    selectSourceCombination(runtime, id),
    /DEPENDENCY_DIGEST_MISMATCH/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(runtime, "source-selection.json"), "utf8")),
    {
      id,
      manifestSha256: createHash("sha256")
        .update(await readFile(join(directory, "combination.json")))
        .digest("hex"),
    },
  );
});

test("one-time layout upgrade preserves the old code directory and leaves user state in place", async (t) => {
  const runtime = await realpath(
    await mkdtemp(join(tmpdir(), "source-layout-")),
  );
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const modules = join(
    runtime,
    "home/profiles/plugin-split-validation/node_modules",
  );
  await mkdir(modules, { recursive: true });
  await writeFile(join(modules, "old-module.js"), "old code");
  await writeFile(join(runtime, "session.json"), "persistent data");
  await upgradeSourceProfileLayout(runtime);
  const record = JSON.parse(
    await readFile(join(runtime, "source-layout-upgrade.json"), "utf8"),
  );
  assert.equal(
    await readFile(join(record.backup, "old-module.js"), "utf8"),
    "old code",
  );
  assert.equal(
    await readFile(join(runtime, "session.json"), "utf8"),
    "persistent data",
  );
});

test("recovery rejects a transitive dependency retarget or added file while old bytes remain", async (t) => {
  const runtime = await realpath(
    await mkdtemp(join(tmpdir(), "source-topology-")),
  );
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const id = randomUUID(),
    directory = join(runtime, "source-combinations", id),
    root = join(runtime, "external"),
    a = join(runtime, "A"),
    b = join(runtime, "B");
  for (const path of [directory, join(root, "node_modules"), a, b])
    await mkdir(path, { recursive: true });
  await writeFile(join(a, "entry.js"), "version A");
  await writeFile(join(b, "entry.js"), "version B");
  const link = join(root, "node_modules/dep");
  await symlink(a, link);
  await writeFile(
    join(directory, "combination.json"),
    JSON.stringify({
      composition: { id, dependencies: {} },
      files: {},
      externalRoots: [root],
      externalLockFiles: [],
      externalFiles: {
        [link]: "link:" + a,
        [join(a, "entry.js")]: createHash("sha256")
          .update("version A")
          .digest("hex"),
      },
    }),
  );
  await selectSourceCombination(runtime, id);
  await rm(link);
  await symlink(b, link);
  await assert.rejects(
    selectSourceCombination(runtime, id),
    /DEPENDENCY_DIGEST_MISMATCH/,
  );
  await rm(link);
  await symlink(a, link);
  await writeFile(join(root, "entry.js"), "new resolver input");
  await assert.rejects(
    selectSourceCombination(runtime, id),
    /DEPENDENCY_DIGEST_MISMATCH/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(runtime, "source-selection.json"), "utf8")),
    {
      id,
      manifestSha256: createHash("sha256")
        .update(await readFile(join(directory, "combination.json")))
        .digest("hex"),
    },
  );
});

test('a verified rebuild replaces drifted dependencies while retaining the selection CAS', async t => {
 const runtime=await realpath(await mkdtemp(join(tmpdir(),'source-rebuild-')));
 t.after(()=>rm(runtime,{recursive:true,force:true}));
 const dependencies=join(runtime,'dependencies');await mkdir(dependencies);const input=join(dependencies,'input.txt');
 const hash=text=>createHash('sha256').update(text).digest('hex');
 async function snapshot(id,content){const dir=join(runtime,'source-combinations',id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'page.html'),content);await writeFile(join(dir,'combination.json'),JSON.stringify({composition:{id,dependencies:{}},files:{'page.html':hash(content)},externalRoots:[dependencies],externalFiles:{[input]:hash(content)},externalLockFiles:[]}));}
 const before=randomUUID(),after=randomUUID();await writeFile(input,'before');await snapshot(before,'before');await selectSourceCombination(runtime,before);const expected=JSON.parse(await readFile(join(runtime,'source-selection.json'),'utf8'));
 await writeFile(input,'after');await snapshot(after,'after');await assert.rejects(readSourceCombination(runtime,before),/DEPENDENCY_DIGEST_MISMATCH/);
 await assert.rejects(selectSourceCombination(runtime,after,undefined,{expected:{...expected,manifestSha256:'wrong'}}),/STALE_SOURCE_RECOVERY/);
 await selectSourceCombination(runtime,after,undefined,{expected});assert.equal(JSON.parse(await readFile(join(runtime,'source-selection.json'),'utf8')).id,after);
 await assert.rejects(selectSourceCombination(runtime,before,undefined,{expected}),/STALE_SOURCE_RECOVERY/);
 await writeFile(input,'drift-again');const current=JSON.parse(await readFile(join(runtime,'source-selection.json'),'utf8'));await assert.rejects(selectSourceCombination(runtime,after,undefined,{expected:current}),/DEPENDENCY_DIGEST_MISMATCH/);
});
