import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { profile } from "./profile.mjs";

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
    const app = await profile(
      {
        after: (fn) => {
          cleanup = fn;
        },
      },
      { execArgv: [script], desktopGraph: directory },
    );
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
