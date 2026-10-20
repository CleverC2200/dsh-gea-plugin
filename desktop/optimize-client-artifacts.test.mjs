/** Browser registrations execute together; helper variables must remain package-local. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

test("optimized registration factories retain their own helpers across concatenated scripts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gea-optimize-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = {
    first:
      'var helper=(target,name)=>Object.defineProperty(target,"name",{value:name,configurable:true});window.__ModuleLoader__.load({id:"first",factory:()=>{function named(){};helper(named,"first");return named.name;}});',
    second:
      'var helper=Object.defineProperty;window.__ModuleLoader__.load({id:"second",factory:()=>helper({},"value",{value:2}).value});',
  };
  for (const [name, source] of Object.entries(sources)) {
    const dir = join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name,
        dsh: { client: { platform: "web" } },
        exports: { "./client": "./client.js" },
      }),
    );
    await writeFile(join(dir, "client.js"), source);
  }
  const workbench = join(root, "node_modules/@cleverc2200/gea-dsh-prototype/lib");
  await mkdir(workbench, { recursive: true });
  await writeFile(join(workbench, "workbench.js"), "window.workbenchLoaded=true;");
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("./optimize-client-artifacts.mjs", import.meta.url)),
      root,
      createRequire(import.meta.url).resolve("esbuild"),
    ],
    { stdio: "pipe" },
  );
  const registrations = new Map();
  const context = {
    window: { __ModuleLoader__: { load: (r) => registrations.set(r.id, r.factory) } },
  };
  for (const name of Object.keys(sources))
    runInNewContext(await readFile(join(root, "node_modules", name, "client.js"), "utf8"), context);
  assert.equal(registrations.get("first")(), "first");
  assert.equal(registrations.get("second")(), 2);
  assert.equal(Object.hasOwn(context, "helper"), false);
  assert.equal(JSON.parse(await readFile(join(root, "client-artifacts.json"))).files.length, 3);
});
