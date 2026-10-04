import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const builder = fileURLToPath(new URL("./build.mjs", import.meta.url));
const outputs = [
  "lib/host.js",
  "lib/skill-reference.js",
  "lib/client.js",
  "lib/workbench.js",
  "lib/workbench.css",
];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-build-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = {
    "src/page-interaction/host.ts": "export function apply() {}",
    "src/page-bridge/index.ts": "export const bridge = true;",
    "src/host.ts": "export const value = 'host-original';",
    "src/skill-reference.ts": "export const value = 'skill';",
    "src/client.tsx": "export const value = 'client';",
    "src/workbench-entry.tsx":
      "import './style.css'; export const value = 'workbench';",
    "src/style.css": "body { color: red; }",
  };
  for (const [file, content] of Object.entries(inputs)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}

function run(root, args = []) {
  const child = spawn(process.execPath, [builder, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (data) => {
    log += data;
  });
  child.stderr.on("data", (data) => {
    log += data;
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, log }));
  });
  return { child, done, log: () => log };
}

async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail("build condition not reached within 10 seconds");
}

test(
  "all preserves outputs; host target leaves other targets untouched; invalid targets fail",
  { timeout: 20000 },
  async (t) => {
    const root = await fixture(t);
    assert.equal((await run(root).done).code, 0);
    for (const file of outputs)
      assert.ok((await stat(join(root, file))).size > 0, file);
    assert.match(
      await readFile(join(root, "lib/client.js"), "utf8"),
      /window\.__ModuleLoader__\.load/,
    );
    const unaffected = outputs.filter(
      (file) => !["lib/host.js", "lib/skill-reference.js"].includes(file),
    );
    const before = await Promise.all(
      unaffected.map((file) => stat(join(root, file))),
    );
    await writeFile(
      join(root, "src/host.ts"),
      "export const value = 'host-changed';",
    );
    assert.equal((await run(root, ["--target", "host"]).done).code, 0);
    assert.match(
      await readFile(join(root, "lib/host.js"), "utf8"),
      /host-changed/,
    );
    for (const [i, file] of unaffected.entries())
      assert.equal(
        (await stat(join(root, file))).mtimeMs,
        before[i].mtimeMs,
        file,
      );
    const invalid = await run(root, ["--target", "unknown"]).done;
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.log, /UNKNOWN_BUILD_TARGET/);
  },
);


test(
  "watch rebuilds client wrapper, retains last good output on syntax errors and shuts down",
  { timeout: 30000 },
  async (t) => {
    const root = await fixture(t);
    const watch = run(root, ["--target", "client", "--watch"]);
    t.after(async () => {
      if (watch.child.exitCode === null) watch.child.kill("SIGTERM");
      await watch.done;
    });
    const output = join(root, "lib/client.js");
    const content = () => readFile(output, "utf8").catch(() => "");
    await until(async () => (await content()).includes("client"));
    await writeFile(
      join(root, "src/client.tsx"),
      "export const value = 'watch-updated';",
    );
    await until(async () => (await content()).includes("watch-updated"));
    const good = await content();
    assert.match(good, /window\.__ModuleLoader__\.load/);
    await writeFile(join(root, "src/client.tsx"), "export const value = ;");
    await until(() => watch.log().includes("ERROR"));
    assert.equal(await content(), good);
    await writeFile(
      join(root, "src/client.tsx"),
      "export const value = 'watch-recovered';",
    );
    await until(async () => (await content()).includes("watch-recovered"));
    watch.child.kill("SIGTERM");
    const stopped = await watch.done;
    assert.equal(stopped.code, 0, stopped.log);
  },
);
