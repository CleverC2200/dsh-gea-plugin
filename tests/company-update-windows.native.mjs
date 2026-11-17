import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";
import { CompanyInstallation } from "../desktop/company-installation.mjs";
import { windowsCompanyInput } from "../scripts/ci-windows-update.mjs";

const app = process.env.GEA_WINDOWS_APP;
const evidence = process.env.GEA_WINDOWS_EVIDENCE;
if (process.platform !== "win32" || !app || !evidence)
  throw Error("WINDOWS_COMPANY_INPUT_REQUIRED");
const executable = join(app, "GEA Desktop.exe");
const root = join(app, "resources/app.asar");
const ownFile = fileURLToPath(import.meta.url);
const gea = "@cleverc2200/gea-dsh-prototype";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(action, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let error;
  do {
    try {
      const value = await action();
      if (value) return value;
    } catch (failure) {
      error = failure;
    }
    await wait(250);
  } while (Date.now() < deadline);
  throw Error("WINDOWS_COMPANY_WAIT_FAILED", { cause: error });
}

if (process.argv[2] === "prepare-worker") {
  const installation = new CompanyInstallation(process.argv[3], windowsCompanyInput.coreHead);
  await installation.prepare("interrupted", async (stage) => {
    await writeFile(
      join(stage, "node_modules", gea, "lib/host.js"),
      "throw Error('INTERRUPTED_CANDIDATE');",
    );
    await writeFile(process.argv[4], stage);
    await new Promise(() => setInterval(() => {}, 1000));
  });
} else
  test(
    "released Windows desktop entry survives killed preparation, killed trial and automatic boot rollback without changing user data",
    { timeout: 330000 },
    async (t) => {
      const home = await mkdtemp(join(evidence, "company-home-"));
      const profile = join(home, "profiles/desktop");
      const env = {
        ...process.env,
        DSH_HOME: home,
        APPDATA: join(home, "appData"),
        LOCALAPPDATA: join(home, "localAppData"),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      await mkdir(env.APPDATA, { recursive: true });
      await mkdir(env.LOCALAPPDATA, { recursive: true });
      execFileSync(
        executable,
        [
          "--expose-internals",
          join(root, "company-bootstrap.mjs"),
          root,
          join(app, "resources/runtime"),
          join(app, "resources/company-seed"),
        ],
        {
          env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
          timeout: 180000,
          stdio: "inherit",
        },
      );
      const installation = new CompanyInstallation(profile, windowsCompanyInput.coreHead);
      const load = createRequire(join(process.env.GEA_WINDOWS_RUNTIME, "dsh/package.json"));
      const configured = load("yaml").parse(
        await readFile(join(profile, "cordis.patch.yml"), "utf8"),
      );
      assert.equal(
        configured.find((row) => row.id === "gea-proof").config.pluginUpdates.installationProtocol,
        1,
      );
      const { Context } = await import(pathToFileURL(load.resolve("@deepseek-ai/cordis")));
      const { default: Persistence } = await import(
        pathToFileURL(load.resolve("@deepseek-ai/dsh-session-persistence-jsonl"))
      );
      const { SESSION_FORMAT_VERSION } = await import(
        pathToFileURL(load.resolve("@deepseek-ai/dsh-session"))
      );
      const header = {
        version: SESSION_FORMAT_VERSION,
        id: "interrupted-update-retention",
        createdAt: 1,
        isSeeded: false,
      };
      const events = [
        { type: "turn/start", seq: 0, time: 2, data: { turn: 1 } },
        {
          type: "user/message",
          surfaceOp: "append",
          seq: 1,
          time: 3,
          data: {
            id: "kept",
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: "保留更新前的会话" }],
          },
        },
        { type: "turn/end", seq: 2, time: 4, data: { turn: 1, reason: { kind: "completed" } } },
      ];
      const persistence = async (create) => {
        const ctx = new Context();
        try {
          await ctx.plugin(Persistence, { root: join(home, "sessions"), compression: "none" });
          const handle = create
            ? await ctx.sessionPersistence.create(header)
            : await ctx.sessionPersistence.open(header.id, "read");
          try {
            if (create) {
              await handle.append(events);
              await handle.flush();
            } else assert.deepEqual((await handle.read()).events, events);
          } finally {
            await handle.close();
          }
        } finally {
          await ctx.fiber.dispose();
        }
      };
      await persistence(true);
      const retained = {
        "user-draft.json": '{"text":"未完成的工作"}',
        "test-credentials.encrypted": "encrypted-test-value",
      };
      for (const [name, value] of Object.entries(retained))
        await writeFile(join(home, name), value);
      const patch = await readFile(join(profile, "cordis.patch.yml"));
      const baseline = await readFile(join(profile, "node_modules", gea, "lib/host.js"));
      const preserved = async () => {
        assert.deepEqual(await readFile(join(profile, "cordis.patch.yml")), patch);
        for (const [name, value] of Object.entries(retained))
          assert.equal(await readFile(join(home, name), "utf8"), value);
        await persistence(false);
      };
      const server = createServer();
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      await new Promise((resolve) => server.close(resolve));
      const stop = () => {
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "$target=$env:GEA_ACCEPTANCE_EXECUTABLE; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }",
          ],
          {
            env: { ...process.env, GEA_ACCEPTANCE_EXECUTABLE: executable },
            stdio: "ignore",
          },
        );
      };
      t.after(stop);
      let logs = "";
      const start = () => {
        const child = spawn(executable, ["--remote-debugging-port=" + port], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (bytes) => {
          logs += bytes;
        });
        child.stderr.on("data", (bytes) => {
          logs += bytes;
        });
        return child;
      };
      const window = async (name) => {
        let browser;
        try {
          const page = await until(async () => {
            if (!browser?.isConnected())
              browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, {
                timeout: 1500,
              });
            const pages = browser
              .contexts()
              .flatMap((context) => context.pages())
              .filter(
                (page) => !page.url().startsWith("devtools:") && page.url() !== "about:blank",
              );
            for (const page of pages) {
              const text = await page.locator("body").innerText({ timeout: 1000 });
              if (text.includes("GEA") && !text.includes("安装或升级未完成")) return page;
            }
            return false;
          });
          if (name === "baseline") {
            const endpoint = await until(
              () =>
                [...logs.matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/g)].at(
                  -1,
                )?.[1],
            );
            const origin = new URL(endpoint).origin;
            const cookie = await until(async () => {
              const exchange = await fetch(endpoint, { redirect: "manual" });
              if (exchange.status !== 303) throw Error("LEGACY_TOKEN_EXCHANGE_" + exchange.status);
              return exchange.headers.get("set-cookie")?.split(";", 1)[0];
            });
            const status = await until(async () => {
              const response = await fetch(origin + "/api/gea/plugin-updates/status", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Origin: origin,
                  Cookie: cookie,
                },
                body: JSON.stringify({ pageIdentity: "windows-legacy-fallback" }),
              });
              if (!response.ok) throw Error("LEGACY_STATUS_HTTP_" + response.status);
              const body = (await response.json()).value;
              if (!body?.items?.length) throw Error("LEGACY_STATUS_NOT_READY");
              return (
                body?.items?.length &&
                body.items.every((row) => row.state === "blocked" && row.planId === null) &&
                body
              );
            });
            assert.equal(status.restartReady, false);
            assert(status.items.every((row) => row.diagnostic === "UPDATE_CONFIG_INVALID"));
          }
          await page.screenshot({ path: join(evidence, name + ".png") });
          return { url: page.url(), title: await page.title() };
        } catch (error) {
          if (browser?.isConnected())
            await writeFile(
              join(evidence, name + "-windows.json"),
              JSON.stringify(
                await Promise.all(
                  browser
                    .contexts()
                    .flatMap((context) => context.pages())
                    .map(async (page) => ({
                      url: page.url(),
                      title: await page.title().catch(() => ""),
                      text: await page
                        .locator("body")
                        .innerText({ timeout: 1000 })
                        .catch(() => ""),
                    })),
                ),
                null,
                2,
              ),
            );
          throw error;
        } finally {
          await browser?.close().catch(() => {});
        }
      };
      const results = [];
      try {
        start();
        results.push({ stage: "baseline", window: await window("baseline") });
        stop();
        await installation.store.confirmBoot("baseline");
        const ready = join(home, "preparation-started");
        const worker = spawn(executable, [ownFile, "prepare-worker", profile, ready], {
          env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: "inherit",
        });
        await until(() => readFile(ready, "utf8"));
        execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" });
        await until(async () => {
          try {
            process.kill(worker.pid, 0);
            return false;
          } catch {
            return true;
          }
        });
        start();
        results.push({ stage: "killed-preparation", window: await window("killed-preparation") });
        assert.equal((await installation.store.status()).active, "baseline");
        await preserved();
        stop();
        const broken = async (stage) =>
          writeFile(
            join(stage, "node_modules", gea, "lib/host.js"),
            "throw Error('CANDIDATE_STARTUP_FAILURE');",
          );
        await installation.prepare("killed-trial", broken);
        start();
        await until(async () => (await installation.store.status()).active === "killed-trial");
        stop();
        start();
        results.push({ stage: "killed-trial", window: await window("killed-trial") });
        assert.equal((await installation.store.status()).active, "baseline");
        await preserved();
        stop();
        await installation.prepare("failed-startup", broken);
        start();
        await until(async () => (await installation.store.status()).active === "failed-startup");
        await until(async () => (await installation.store.status()).active === "baseline", 130000);
        await until(
          async () =>
            (await realpath(join(profile, "node_modules"))) ===
            (await realpath(join(installation.store.baseline, "node_modules"))),
        );
        results.push({ stage: "automatic-rollback", window: await window("automatic-rollback") });
        assert.deepEqual(
          await readFile(join(profile, "node_modules", gea, "lib/host.js")),
          baseline,
        );
        await preserved();
        await writeFile(
          join(evidence, "company-desktop-result.json"),
          JSON.stringify(
            {
              input: windowsCompanyInput,
              sourceHead: process.env.GITHUB_SHA,
              results,
              historyReadWithBundledCore: true,
              userDataPreserved: true,
              productionDataTouched: false,
            },
            null,
            2,
          ),
        );
      } finally {
        await writeFile(
          join(evidence, "company-desktop.log"),
          logs.replace(/([?&]token=)[^\s]+/g, "$1[redacted]"),
        );
        stop();
      }
    },
  );
