import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { sourceWindow } from "../tests/fixtures/source-window.mjs";
import { pathToFileURL } from "node:url";

const launcher = resolve(import.meta.dirname, "start-isolated-validation.mjs");
for (const mode of ["core"])
  test(
    `${mode} launcher serves a profile, denies outside writes and outbound network, then stops`,
    { skip: process.platform !== "darwin", timeout: 20000 },
    async (t) => {
      const declared = await sourceWindow(t, "isolated-core-host");
      const fixture = declared.temporary;
      let child;
      let closed;
      let session;
      try {
        const probe = join(fixture, "isolated-probe.mjs");
        await writeFile(
          probe,
          `
      import { writeFile } from 'node:fs/promises';
      import http from 'node:http';
      import net from 'node:net';
      import assert from 'node:assert/strict';
      assert.equal(process.env.GEA_RELEASE_TOKEN, undefined);
      assert.equal(process.env.NODE_OPTIONS, undefined);
      assert.equal(process.env.DSH_HOME, process.env.HOME);
      await assert.rejects(writeFile(${JSON.stringify(join(fixture, "outside"))}, 'bad'));
      await assert.rejects(new Promise((ok, fail) => {
        const socket = net.connect({ host: '127.0.0.1', port: 9 });
        socket.on('connect', () => { socket.destroy(); ok(); });
        socket.on('error', error => { assert.equal(error.code, 'EPERM'); fail(error); });
      }));
      const server = http.createServer((req, res) => res.end('isolated-profile'));
      server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port));
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `,
        );
        const observer = join(fixture, "sandbox-process-boundary.mjs");
        await writeFile(
          observer,
          `import child from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';const original=child.spawn;child.spawn=(command,args,options)=>{assert.equal(command,'/usr/bin/sandbox-exec');assert.equal(args[0],'-f');assert.match(args.at(-1),/runSourceProfile/);return original(command,[...args.slice(0,-1),${JSON.stringify("import(" + JSON.stringify(pathToFileURL(probe).href) + ")")}],options);};syncBuiltinESMExports();`,
        );
        child = spawn(
          process.execPath,
          [
            join(declared.gea, "scripts/start-isolated-validation.mjs"),
            "--core",
            declared.fixedCore,
            "--window",
            declared.request.file,
            "--case",
            declared.request.case,
            "--owner",
            declared.request.owner,
            "--freeze-sha256",
            declared.request.freezeSha256,
          ],
          {
            env: {
              ...process.env,
              NODE_OPTIONS: "--import=" + pathToFileURL(observer).href,
              GEA_RELEASE_TOKEN: "must-not-inherit",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        closed = once(child, "close");
        void closed.catch(() => {});
        let output = "";
        child.stdout.on("data", (data) => {
          output += data;
        });
        child.stderr.on("data", (data) => {
          output += data;
        });
        const ready = await new Promise((done, reject) => {
          const timer = setTimeout(() => reject(new Error(output || "startup timeout")), 12000);
          child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`exit ${code}: ${output}`));
          });
          child.stdout.on("data", () => {
            const match = output.match(/FIXTURE_URL=(http:\/\/127\.0\.0\.1:\d+)/);
            if (match) {
              clearTimeout(timer);
              done(match[1]);
            }
          });
        });
        session = output.match(/ISOLATED_RUNTIME=(.+)/)?.[1];
        assert.ok(session);
        assert.equal(await (await fetch(ready)).text(), "isolated-profile");
        const provenance = JSON.parse(await readFile(join(session, "provenance.json"), "utf8"));
        assert.equal(
          provenance.mode,
          mode === "core" ? "current-source-build" : "installed-payload-baseline",
        );
        if (mode === "core") assert.match(provenance.coreSource, /^[a-f0-9]{40}$/);
        assert.equal(provenance.companyPlugins, false);
        assert.equal(provenance.core, declared.fixedCore);
        assert.equal(provenance.coreVersion, provenance.packages["@deepseek-ai/dsh"]);
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        assert.equal((await exited)[0], 0);
        const result = JSON.parse(await readFile(join(session, "exit.json"), "utf8"));
        assert.equal(result.stoppedBy, "SIGTERM");
        await assert.rejects(fetch(ready));
      } finally {
        if (child && child.exitCode === null) child.kill("SIGTERM");
        if (closed) {
          let timer;
          try {
            await Promise.race([
              closed,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("test process still running; preserve its files")),
                  7000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        if (session) await rm(session, { recursive: true, force: true });
      }
    },
  );

test("installed payload mode is explicitly unsupported", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, [launcher, "--payload", "not-a-source-checkout"], {
        stdio: "pipe",
      }),
    (error) => /Unknown option.*payload/.test(error.stderr.toString()),
  );
});
