import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";

const launcher = resolve(import.meta.dirname, "start-isolated-validation.mjs");
for (const mode of ["payload", "core"])
  test(
    `${mode} launcher serves a profile, denies outside writes and outbound network, then stops`,
    { skip: process.platform !== "darwin", timeout: 20000 },
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "gea-isolation-test-"));
      let child;
      let closed;
      let session;
      try {
        const payload = join(fixture, "payload");
        const packages = [
          "@deepseek-ai/dsh",
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "@deepseek-ai/dsh-agent-presets",
          "@cleverc2200/gea-dsh-prototype",
          "@cleverc2200/dsh-agent-workbench",
          "dsh-agent-manage",
          "dsh-plugin",
        ];
        for (const name of packages) {
          const dir =
            mode === "payload"
              ? join(payload, "node_modules", name)
              : name === "@deepseek-ai/dsh"
                ? join(payload, "apps/cli")
                : join(payload, "vendor", name.replaceAll("/", "-"));
          await mkdir(dir, { recursive: true });
          await writeFile(
            join(dir, "package.json"),
            JSON.stringify({ name, version: "1.0.0", type: "module" }),
          );
        }
        await mkdir(join(payload, "node/bin"), { recursive: true });
        await symlink(process.execPath, join(payload, "node/bin/node"));
        await writeFile(
          join(payload, "package.json"),
          JSON.stringify({
            private: true,
            version: "fixture",
            dependencies: Object.fromEntries(
              packages.map((name) => [name, "1.0.0"]),
            ),
          }),
        );
        await writeFile(join(payload, "pnpm-lock.yaml"), "fixture-lock\n");
        const gea = join(
          payload,
          "node_modules/@cleverc2200/gea-dsh-prototype/scripts",
        );
        await mkdir(gea, { recursive: true });
        await writeFile(
          join(gea, "deployment.mjs"),
          `export async function prepareNativePreset() {}\nexport function deploymentPatch() { return []; }\n`,
        );
        if (mode === "core") {
          await mkdir(join(payload, "apps/web/dist"), { recursive: true });
          await writeFile(
            join(payload, "apps/web/dist/index.html"),
            "<!doctype html>",
          );
          execFileSync("git", ["init", "-q", payload]);
          execFileSync(
            "git",
            [
              "-c",
              "user.name=fixture",
              "-c",
              "user.email=fixture@example.invalid",
              "commit",
              "--allow-empty",
              "-qm",
              "fixture",
            ],
            { cwd: payload },
          );
        }
        const cli =
          mode === "core"
            ? join(payload, "apps/cli/lib")
            : join(payload, "node_modules/@deepseek-ai/dsh/lib");
        await mkdir(cli);
        await writeFile(
          join(cli, "bin.js"),
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
        child = spawn(process.execPath, [launcher, `--${mode}`, payload], {
          env: { ...process.env, GEA_RELEASE_TOKEN: "must-not-inherit" },
          stdio: ["ignore", "pipe", "pipe"],
        });
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
          const timer = setTimeout(
            () => reject(new Error(output || "startup timeout")),
            12000,
          );
          child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`exit ${code}: ${output}`));
          });
          child.stdout.on("data", () => {
            const match = output.match(
              /FIXTURE_URL=(http:\/\/127\.0\.0\.1:\d+)/,
            );
            if (match) {
              clearTimeout(timer);
              done(match[1]);
            }
          });
        });
        session = output.match(/ISOLATED_RUNTIME=(.+)/)?.[1];
        assert.ok(session);
        assert.equal(await (await fetch(ready)).text(), "isolated-profile");
        const provenance = JSON.parse(
          await readFile(join(session, "provenance.json"), "utf8"),
        );
        assert.equal(
          provenance.mode,
          mode === "core"
            ? "official-source-build"
            : "installed-payload-baseline",
        );
        if (mode === "core")
          assert.match(provenance.coreSource, /^[a-f0-9]{40}$/);
        assert.equal(provenance.packages["dsh-agent-manage"], "1.0.0");
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        assert.equal((await exited)[0], 0);
        const result = JSON.parse(
          await readFile(join(session, "exit.json"), "utf8"),
        );
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
                  () =>
                    reject(
                      new Error(
                        "test process still running; preserve its files",
                      ),
                    ),
                  7000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        await rm(fixture, { recursive: true, force: true });
        if (session) await rm(session, { recursive: true, force: true });
      }
    },
  );
