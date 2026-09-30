/** Switch real source profiles between pinned local combinations; external services are fixtures. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { profile, readSession, readToolResults, until } from "./profile.mjs";
import { installStockRoutes, stockState } from "./fixtures/branch-stock.mjs";
import {
  prepareSourcePlugins,
  readSourceCombination,
  selectSourceCombination,
  upgradeSourceProfileLayout,
} from "../scripts/source-profile.mjs";
import { readDeployment } from "../scripts/deployment.mjs";

const core = resolve("../deepseek-harness"),
  parent = resolve(".runtime/ticket-09");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test(
  "supported stock combinations update and restore on the same durable profile",
  { skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 180000 },
  async (t) => {
    await mkdir(parent, { recursive: true });
    let previous, candidate;
    const app = await profile(t, {
      normalStartup: true,
      runtimeParent: parent,
      preserveRuntime: true,
      config: (base) => ({
        analysis: {
          mode: "model",
          baseUrl: base + "/v1",
          model: "fixture",
          apiKeyEnv: "GEA_TEST_MODEL_KEY",
          agentCode: "branch-inventory",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { GEA_TEST_MODEL_KEY: "fixture-key" },
      beforeStart: async ({ runtime, config }) => {
        await mkdir(join(runtime, "home/profiles/plugin-split-validation"), {
          recursive: true,
        });
        const deployment = await readDeployment(config);
        const baselineAssembler = await import(
          new URL(
            "../../../../dsh-gea-plugin/scripts/source-profile.mjs",
            import.meta.url,
          )
        );
        await baselineAssembler.prepareSourcePlugins(core, runtime, deployment);
        await mkdir(join(runtime, "workspace"), { recursive: true });
        await writeFile(
          join(runtime, "workspace/preexisting-user.txt"),
          "ticket08 user state",
        );
        await upgradeSourceProfileLayout(runtime);
        // The recovery artifacts are read from the clean, registered ticket08 checkout.
        previous = await prepareSourcePlugins(core, runtime, deployment, {
          workspace: resolve("../../.."),
        });
        candidate = await prepareSourcePlugins(core, runtime, deployment);
        await writeFile(
          join(runtime, "local-channel.json"),
          JSON.stringify(
            {
              scope: "loopback-only/current-unified-interface",
              previous: previous.id,
              candidate: candidate.id,
            },
            null,
            2,
          ),
        );
        await selectSourceCombination(runtime, previous.id, core);
      },
    });
    const state = stockState();
    installStockRoutes(app, state, (body) => {
      const index = body.messages.findLastIndex(
        (message) => message.role === "user",
      );
      const tools = body.messages
        .slice(index + 1)
        .filter((message) => message.role === "tool");
      const name = tools.length === 0 ? "gea_skill" : "gea_cube_query";
      if (tools.length < 2)
        return {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(
                  name === "gea_skill"
                    ? { name: "inventory-fc", offset: 1, limit: 80 }
                    : {
                        consumerCode: "branch-inventory",
                        queries: [
                          {
                            name: "branch_stock",
                            query: {
                              dimensions: ["branch_stock.material_code"],
                              measures: ["branch_stock.available_qty"],
                              limit: 10,
                            },
                          },
                        ],
                      },
                ),
              },
            },
          ],
        };
      const receipts = tools.map((value) => value.content).join("\n");
      assert.match(receipts, /100/);
      assert.match(receipts, /30/);
      return {
        content:
          "本地样本FC001=100件、FC002=30件，合计130件；依据本轮Skill及Cube回执。",
      };
    });
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    t.after(() => browser.close());
    const userFile = join(app.runtime, "workspace/user-data.txt");
    await writeFile(
      userFile,
      "user-owned data kept across update and restore\n",
    );
    const settingsFile = join(
      app.runtime,
      "home/profiles/plugin-split-validation/cordis.patch.yml",
    );
    let settingsBefore;
    const records = [];
    let durableSession, oldScope, oldLease, oldRows;
    for (const [phase, combination] of [
      ["previous", previous],
      ["candidate", candidate],
      ["restored", previous],
    ]) {
      if (records.length) {
        await app.stop();
        await selectSourceCombination(app.runtime, combination.id, core);
        await app.start();
        assert.equal(hash(await readFile(settingsFile)), settingsBefore);
        assert.deepEqual(
          await readSession(app.runtime, durableSession),
          oldRows,
          "Host restart preserves every prior Session row before fresh activity",
        );
      }
      await assert.rejects(
        selectSourceCombination(app.runtime, combination.id, core),
        { code: "EEXIST" },
      );
      assert.equal((await app.login()).ok, true);
      const identityResponse = await fetch(
        app.origin + "/api/gea-html/identity",
        { headers: { Cookie: app.cookie } },
      );
      const scope = (await identityResponse.json()).scope;
      assert.ok(scope);
      if (oldScope)
        assert.notEqual(
          scope,
          oldScope,
          "new Host invalidates the prior identity generation",
        );
      const request = async (endpoint, body) => {
        const response = await fetch(
          app.origin + "/api/gea-html/inventory-fc/" + endpoint,
          {
            method: "POST",
            headers: {
              Cookie: app.cookie,
              Origin: app.origin,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          },
        );
        return { status: response.status, body: await response.json() };
      };
      let rejectedScope, rejectedLease;
      if (oldScope) {
        rejectedScope = await request("open", {
          session: durableSession,
          agentPreset: "gea-html-inventory-fc",
          scope: oldScope,
        });
        assert.equal(rejectedScope.status, 400);
        assert.equal(
          rejectedScope.body.error,
          "PAGE_SESSION_IDENTITY_MISMATCH",
        );
        rejectedLease = await request("call", {
          session: durableSession,
          lease: oldLease,
          method: "context",
          parameters: {},
        });
        assert.equal(rejectedLease.status, 400);
        assert.match(rejectedLease.body.error, /LEASE/);
      }
      const context = await browser.newContext({
        locale: "zh-CN",
        viewport: { width: 1440, height: 1000 },
      });
      await context.addCookies(
        app.cookie.split("; ").map((pair) => ({
          name: pair.slice(0, pair.indexOf("=")),
          value: pair.slice(pair.indexOf("=") + 1),
          url: app.origin,
        })),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      let opened;
      page.on("response", async (response) => {
        if (
          response.url().endsWith("/api/gea-html/inventory-fc/open") &&
          response.ok()
        )
          opened = await response.json();
      });
      await page.goto(app.origin);
      const notice = page.getByRole("dialog", { name: /内测声明|预览版说明/ });
      if (await notice.isVisible())
        await notice.getByRole("button", { name: "继续", exact: true }).click();
      if (!(await page.getByText("分仓库存", { exact: true }).isVisible()))
        await page.getByText("库存管理", { exact: true }).click();
      await page.getByText("分仓库存", { exact: true }).click();
      const frame = page
        .locator('iframe[src*="/api/gea-html/inventory-fc/html"]')
        .contentFrame();
      await expect(
        frame.getByText("FC001", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        frame.getByText("FC002", { exact: true }).first(),
      ).toBeVisible();
      await expect.poll(() => typeof opened?.lease).toBe("string");
      const agentsResponse = await fetch(
        app.origin + "/api/gea-html/inventory-fc/agents",
        { headers: { Cookie: app.cookie } },
      );
      const agents = await agentsResponse.json();
      assert.deepEqual(
        agents.map((value) => value.preset),
        ["gea-html-inventory-fc"],
      );
      const pluginsResponse = await fetch(
        app.origin + "/api/gea-html/plugins",
        { headers: { Cookie: app.cookie } },
      );
      const plugins = await pluginsResponse.json();
      assert.equal(
        plugins.filter((value) => value.id === "inventory-fc").length,
        1,
        "one resource registration",
      );
      if (!durableSession) {
        const created = await app.remote("session/create", {
          cwd: app.runtime + "/workspace",
          agentPreset: "gea-html-inventory-fc",
        });
        assert.equal(created.ok, true);
        durableSession = created.value.sessionId;
      }
      assert.equal(
        (
          await app.remote("session/selectModel", {
            sessionId: durableSession,
            provider: "gea-analysis",
            model: "fixture",
          })
        ).ok,
        true,
      );
      assert.equal(
        (
          await request("open", {
            session: durableSession,
            agentPreset: "gea-html-inventory-fc",
            scope,
          })
        ).status,
        200,
      );
      const turns = (await readSession(app.runtime, durableSession)).filter(
        (value) => value.type === "turn/end",
      ).length;
      assert.equal(
        (
          await app.remote("session/prompt", {
            sessionId: durableSession,
            requestId: randomUUID(),
            mode: "queue",
            content: [
              {
                type: "text",
                text: "按Skill读取分仓库存，汇总本地样本：" + phase,
              },
            ],
          })
        ).ok,
        true,
      );
      const rows = await until(
        () => readSession(app.runtime, durableSession),
        (rows) =>
          rows.filter((value) => value.type === "turn/end").length > turns,
        60000,
      );
      const receipts = readToolResults(rows).slice(-2);
      assert.ok(receipts.every((value) => !value.isError));
      assert.match(receipts[0].text, /inventory-fc|分仓/);
      assert.match(receipts[1].text, /100/);
      assert.match(receipts[1].text, /30/);
      assert.match(JSON.stringify(rows), /合计130件/);
      assert.equal(
        await readFile(
          join(app.runtime, "workspace/preexisting-user.txt"),
          "utf8",
        ),
        "ticket08 user state",
      );
      const modules = await realpath(
        join(app.runtime, "home/profiles/plugin-split-validation/node_modules"),
      );
      assert.equal(
        modules,
        join(
          app.runtime,
          "source-combinations",
          combination.id,
          "node_modules",
        ),
      );
      const pageSource = await readFile(
        join(
          modules,
          "@cleverc2200/dsh-agent-workbench/lib/business/inventory-fc/index.html",
        ),
        "utf8",
      );
      const pageScript = pageSource.match(/<script>([\s\S]*)<\/script>/)[1];
      const loadedScripts = await frame
        .locator("script")
        .evaluateAll((scripts) => scripts.map((script) => script.textContent));
      assert.ok(
        loadedScripts.includes(pageScript),
        "iframe executes the selected snapshot's page bytes",
      );
      if (!settingsBefore) settingsBefore = hash(await readFile(settingsFile));
      assert.equal(hash(await readFile(settingsFile)), settingsBefore);
      assert.equal(
        await readFile(userFile, "utf8"),
        "user-owned data kept across update and restore\n",
      );
      await page.screenshot({
        path: join(parent, phase + ".png"),
        fullPage: true,
      });
      const manifest = JSON.parse(
        await readFile(
          join(
            app.runtime,
            "source-combinations",
            combination.id,
            "combination.json",
          ),
          "utf8",
        ),
      );
      records.push({
        phase,
        combination: combination.id,
        modules,
        source: JSON.parse(
          await readFile(join(app.runtime, "company-plugins.json"), "utf8"),
        ),
        manifestSha256: hash(JSON.stringify(manifest)),
        pageScriptSha256: hash(pageScript),
        scope,
        session: durableSession,
        opened,
        agents,
        registrations: plugins.filter((value) => value.id === "inventory-fc")
          .length,
        sql: state.rest.map((value) => value.sql),
        receipts,
        rows,
        rejectedScope,
        rejectedLease,
        settingsSha256: settingsBefore,
        userDataSha256: hash(await readFile(userFile)),
      });
      oldScope = scope;
      oldLease = opened.lease;
      oldRows = rows;
      await context.close();
    }
    await app.stop();
    await readSourceCombination(app.runtime, previous.id, core);
    await writeFile(
      join(parent, "acceptance.json"),
      JSON.stringify(
        {
          runtime: app.runtime,
          previous: previous.id,
          candidate: candidate.id,
          records,
        },
        null,
        2,
      ),
    );
  },
);
