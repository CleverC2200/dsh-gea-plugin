import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { profile } from "./profile.mjs";

test("profile refuses compile caching during precise V8 coverage before launching a child", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gea-compile-coverage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "spawned");
  const launcher = join(directory, "launcher.mjs");
  await writeFile(
    launcher,
    `import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'spawned');`,
  );
  let cleanup;
  try {
    await assert.rejects(
      profile(
        {
          name: t.name,
          after: (fn) => {
            cleanup = fn;
          },
        },
        {
          execArgv: [launcher],
          desktopGraph: directory,
          coreOnly: true,
          env: { NODE_V8_COVERAGE: join(directory, "coverage") },
          compileCache: { mode: "on", directory: join(directory, "cache") },
        },
      ),
      /RETURNED_COMPILE_CACHE_COVERAGE_CONFLICT/,
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await cleanup?.();
  }
});

test("explicit profile compile caching reaches fresh wrapper and Core processes and records their files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gea-compile-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = join(directory, "lifecycle.jsonl");
  const previousReceipt = process.env.GEA_TEST_LIFECYCLE_RECEIPT;
  process.env.GEA_TEST_LIFECYCLE_RECEIPT = receipt;
  t.after(() => {
    if (previousReceipt === undefined) delete process.env.GEA_TEST_LIFECYCLE_RECEIPT;
    else process.env.GEA_TEST_LIFECYCLE_RECEIPT = previousReceipt;
  });
  const parentCache = process.env.NODE_COMPILE_CACHE;
  const core = join(directory, "apps/cli/lib/bin.js");
  await mkdir(join(directory, "apps/cli/lib"), { recursive: true });
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  const verifier = join(directory, "verifier.mjs");
  await writeFile(verifier, "export const verified = true;");
  const wrapper = join(directory, "wrapper.mjs");
  await writeFile(
    core,
    `import http from 'node:http';
    const server=http.createServer((req,res)=>{res.setHeader('Set-Cookie','fixture=1');res.end('ready')});
    server.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?token=fixture'));
    process.on('SIGTERM',()=>process.exit(0));`,
  );
  await writeFile(
    wrapper,
    `import {spawn,execFileSync} from 'node:child_process';
    execFileSync(process.execPath,[${JSON.stringify(verifier)}],{env:process.env});
    const child=spawn(process.execPath,[${JSON.stringify(core)}],{env:process.env,stdio:'inherit'});
    process.on('SIGTERM',()=>child.kill('SIGTERM'));
    child.on('exit',code=>{process.exitCode=code??1;});`,
  );
  const runtimes = new Set();
  const pids = new Set();
  for (const mode of [undefined, "off", "on"]) {
    const cache = join(directory, mode ?? "default");
    await mkdir(cache);
    for (let index = 0; index < 2; index++) {
      const name = `${mode}-${index}`;
      let cleanup;
      try {
        const app = await profile(
          {
            name,
            signal: t.signal,
            after: (fn) => {
              cleanup = fn;
            },
          },
          {
            execArgv: [wrapper],
            desktopGraph: directory,
            coreOnly: true,
            ...(mode ? { compileCache: { mode, directory: cache } } : {}),
          },
        );
        assert.ok(!runtimes.has(app.runtime));
        runtimes.add(app.runtime);
        await app.stop();
        const events = (await readFile(receipt, "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse)
          .filter((event) => event.testName === name);
        const processes = events.filter(
          (event) => event.event === "returned-compile-cache-process",
        );
        if (!mode) {
          assert.equal(processes.length, 0);
          assert.equal(
            events.filter((event) => event.event === "returned-compile-cache-files").length,
            0,
          );
          continue;
        }
        assert.deepEqual(processes.map((event) => event.role).sort(), ["core", "other", "wrapper"]);
        for (const event of processes) {
          assert.ok(!pids.has(event.pid));
          pids.add(event.pid);
          assert.equal(event.mode, mode);
          assert.equal(event.node, process.version);
          assert.equal(event.enabled, mode === "on");
          if (mode === "on") assert.ok(event.cacheDirectory.startsWith(join(cache, event.role)));
          else assert.equal(event.cacheDirectory, null);
        }
        const snapshots = events.filter((event) => event.event === "returned-compile-cache-files");
        assert.deepEqual(
          snapshots.map((event) => event.phase),
          ["before-start", "after-stop"],
        );
        if (index === 0) {
          assert.deepEqual(snapshots[0].files, {
            wrapper: { files: 0, bytes: 0 },
            core: { files: 0, bytes: 0 },
            other: { files: 0, bytes: 0 },
          });
        }
        for (const role of ["wrapper", "core", "other"]) {
          if (mode === "on") {
            assert.ok(snapshots[1].files[role].files > 0);
            assert.ok(snapshots[1].files[role].bytes > 0);
          } else assert.deepEqual(snapshots[1].files[role], { files: 0, bytes: 0 });
        }
      } finally {
        await cleanup?.();
      }
      assert.equal(process.env.NODE_COMPILE_CACHE, parentCache);
    }
  }
});

test(
  "profile cleanup terminates an unresponsive launcher and its server child",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "gea-stubborn-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const script = join(directory, "launcher.mjs");
    const server = `import http from 'node:http';
    const server=http.createServer((req,res)=>{res.setHeader('Set-Cookie','fixture=1');res.end('ready')});
    server.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?token=fixture'));
    process.on('SIGTERM',()=>{});
    setTimeout(()=>process.exit(0),20000);`;
    await writeFile(
      script,
      `import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(server)}],{stdio:'inherit'});
    process.on('SIGTERM',()=>{});child.on('exit',code=>process.exit(code??1));`,
    );
    let cleanup;
    let app;
    try {
      app = await profile(
        {
          signal: t.signal,
          after: (fn) => {
            cleanup = fn;
          },
        },
        // This fixture owns a minimal Core HTTP server, not the GEA business routes.
        { execArgv: [script], desktopGraph: directory, coreOnly: true },
      );
    } catch (error) {
      await cleanup?.();
      throw error;
    }
    const started = Date.now();
    await cleanup();
    assert.ok(Date.now() - started < 15000, "server child survived the forced launcher stop");
    await assert.rejects(fetch(app.origin));
  },
);

test("profile cancellation before launch never starts its owned launcher", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gea-cancelled-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "spawned");
  const script = join(directory, "launcher.mjs");
  await writeFile(
    script,
    `import {writeFileSync} from 'node:fs';
    import http from 'node:http';
    writeFileSync(${JSON.stringify(marker)}, 'spawned');
    const server=http.createServer((req,res)=>{res.setHeader('Set-Cookie','fixture=1');res.end('ready')});
    server.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?token=fixture'))`,
  );
  const controller = new AbortController();
  const reason = new Error("fixture preparation cancelled");
  let cleanup;
  try {
    await assert.rejects(
      profile(
        {
          name: t.name,
          signal: controller.signal,
          after: (fn) => {
            cleanup = fn;
          },
        },
        {
          execArgv: [script],
          desktopGraph: directory,
          coreOnly: true,
          beforeStart: () => controller.abort(reason),
        },
      ),
      (error) => error === reason,
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await cleanup?.();
  }
});
