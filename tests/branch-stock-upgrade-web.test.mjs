import { branchStockAcceptance } from "./fixtures/branch-stock-acceptance.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";
/** Switch real source profiles between pinned local combinations; external services are fixtures. */
import test from "./fixtures/source-test.mjs";
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
import {
  preparePageStartup,
  openWorkbenchPage,
  htmlFrameElement,
  prepareWorkbenchHtmlRoots,
} from "./fixtures/business-page.mjs";
import { selectBusinessResource } from "./fixtures/business-session.mjs";

const core = resolve("../../official-latest-standard"),
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
      beforeStart: async ({ runtime, config, credentialEnv }) => {
        await mkdir(join(runtime, "home/profiles/plugin-split-validation"), {
          recursive: true,
        });
        const deployment = await readDeployment(config, { credentialEnv });
        const sources = JSON.parse(await readFile(process.env.GEA_TEST_SOURCE_INPUTS, "utf8"));
        await mkdir(join(runtime, "workspace"), { recursive: true });
        await writeFile(join(runtime, "workspace/preexisting-user.txt"), "ticket08 user state");
        // The explicit synthetic old layout is the existing source-combination test input,
        // not evidence of a historic ticket08 installation or a different product version.
        const modules = join(runtime, "home/profiles/plugin-split-validation/node_modules");
        await mkdir(modules, { recursive: true });
        await writeFile(join(modules, "old-module.js"), "old code");
        await writeFile(join(runtime, "session.json"), "persistent data");
        await upgradeSourceProfileLayout(runtime);
        const upgrade = JSON.parse(
          await readFile(join(runtime, "source-layout-upgrade.json"), "utf8"),
        );
        assert.equal(await readFile(join(upgrade.backup, "old-module.js"), "utf8"), "old code");
        assert.equal(await readFile(join(runtime, "session.json"), "utf8"), "persistent data");
        await prepareWorkbenchHtmlRoots([
          join(modules, "@cleverc2200/dsh-agent-workbench/lib/business/inventory-fc"),
        ])({ runtime });
        // Independent snapshots of the same admitted source support durable update/restore.
        previous = await prepareSourcePlugins(core, runtime, deployment, {
          sources,
        });
        candidate = await prepareSourcePlugins(core, runtime, deployment, {
          sources,
        });
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
      const index = body.messages.findLastIndex((message) => message.role === "user");
      const tools = body.messages.slice(index + 1).filter((message) => message.role === "tool");
      const name = tools.length === 0 ? "skill" : "gea_cube_query";
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
                  name === "skill"
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
        content: "本地样本FC001=100件、FC002=30件，合计130件；依据本轮Skill及Cube回执。",
      };
    });
    const browser = await testBrowser(t, () =>
      chromium.launch({
        channel: "chrome",
        headless: true,
      }),
    );

    const userFile = join(app.runtime, "workspace/user-data.txt");
    await writeFile(userFile, "user-owned data kept across update and restore\n");
    const settingsFile = join(
      app.runtime,
      "home/profiles/plugin-split-validation/cordis.patch.yml",
    );
    let settingsBefore;
    const records = [];
    let durableSession, oldScope, oldOwner, oldRows;
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
      await assert.rejects(selectSourceCombination(app.runtime, combination.id, core), {
        code: "EEXIST",
      });
      assert.equal((await app.login()).ok, true);
      const identityResponse = await fetch(app.origin + "/api/gea-html/identity", {
        headers: { Cookie: app.cookie },
      });
      const scope = (await identityResponse.json()).scope;
      assert.ok(scope);
      if (oldScope)
        assert.notEqual(scope, oldScope, "new Host invalidates the prior identity generation");
      const request = async (body) => {
        const response = await fetch(app.origin + "/api/agent-workbench/page", {
          method: "POST",
          headers: { Cookie: app.cookie, Origin: app.origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const retired = await fetch(app.origin + "/api/gea-html/inventory-fc/open", {
        method: "POST",
        headers: { Cookie: app.cookie, Origin: app.origin, "content-type": "application/json" },
        body: JSON.stringify({
          session: durableSession,
          agentPreset: "gea-html-inventory-fc",
          scope: oldScope,
        }),
      });
      assert.equal(retired.status, 404);
      let rejectedOwner;
      if (oldOwner) {
        rejectedOwner = await request({ operation: "context", owner: oldOwner, parameters: {} });
        assert.equal(rejectedOwner.status, 400);
        assert.equal(rejectedOwner.body.error, "PAGE_OWNER_RELEASED");
      }
      const selectedResource = await selectBusinessResource(app, "gea-html-inventory-fc");
      assert.equal(selectedResource.preset, "gea-html-inventory-fc");
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
      await page.clock.setFixedTime(new Date(branchStockAcceptance.fixedTime));
      page.setDefaultTimeout(20000);
      let opened;
      const captureOpen = async (response) => {
        if (
          response.url().endsWith("/api/agent-workbench/page") &&
          response.ok() &&
          response.request().postDataJSON()?.operation === "open"
        )
          opened = await response.json();
      };
      page.on("response", captureOpen);
      await page.goto(app.origin);
      await preparePageStartup(page);
      await openWorkbenchPage(page, "分仓库存");
      const frame = htmlFrameElement(page, "inventory-fc").contentFrame();
      await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
      await expect(frame.getByText("FC002", { exact: true }).first()).toBeVisible();
      await expect.poll(() => typeof opened?.owner).toBe("string");
      page.off("response", captureOpen);
      const resourcesResponse = await fetch(
        app.origin +
          "/api/agent-manage/resources?" +
          new URLSearchParams({ cwd: app.runtime + "/workspace" }),
        { headers: { Cookie: app.cookie } },
      );
      assert.equal(resourcesResponse.status, 200);
      const resources = (await resourcesResponse.json()).filter(
        (value) => value.installed && value.kind === "prompt",
      );
      assert.deepEqual(
        resources.map((value) => value.id),
        ["gea-readonly", "gea-html-inventory-fc"],
      );
      const agents = selectedResource.interpreters;
      assert.deepEqual(
        agents,
        ["gea-html-inventory-fc"],
        "only the installed FC interpreter is offered for this page",
      );
      const pagesResponse = await fetch(app.origin + "/api/agent-workbench/pages", {
        headers: { Cookie: app.cookie },
      });
      assert.equal(pagesResponse.status, 200);
      const plugins = await pagesResponse.json();
      assert.equal(
        plugins.filter((value) => value.id === "inventory-fc").length,
        1,
        "one resource registration",
      );
      if (!durableSession) {
        const created = await app.remote("session/create", {
          cwd: app.runtime + "/workspace",
          agentPreset: selectedResource.preset,
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
          await request({
            operation: "open",
            pageId: "inventory-fc",
            sessionId: durableSession,
            resourceId: "gea-html-inventory-fc",
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
        (rows) => rows.filter((value) => value.type === "turn/end").length > turns,
        60000,
      );
      const receipts = readToolResults(rows).slice(-2);
      assert.ok(receipts.every((value) => !value.isError));
      assert.match(receipts[0].text, /inventory-fc|分仓/);
      assert.match(receipts[1].text, /100/);
      assert.match(receipts[1].text, /30/);
      assert.match(JSON.stringify(rows), /合计130件/);
      assert.equal(
        await readFile(join(app.runtime, "workspace/preexisting-user.txt"), "utf8"),
        "ticket08 user state",
      );
      const modules = await realpath(
        join(app.runtime, "home/profiles/plugin-split-validation/node_modules"),
      );
      assert.equal(
        modules,
        join(app.runtime, "source-combinations", combination.id, "node_modules"),
      );
      const pageSource = await readFile(
        join(modules, "@cleverc2200/dsh-agent-workbench/lib/business/inventory-fc/index.html"),
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
          join(app.runtime, "source-combinations", combination.id, "combination.json"),
          "utf8",
        ),
      );
      records.push({
        phase,
        combination: combination.id,
        modules,
        source: JSON.parse(await readFile(join(app.runtime, "company-plugins.json"), "utf8")),
        manifestSha256: hash(JSON.stringify(manifest)),
        pageScriptSha256: hash(pageScript),
        scope,
        session: durableSession,
        opened,
        agents,
        registrations: plugins.filter((value) => value.id === "inventory-fc").length,
        sql: state.rest.map((value) => value.sql),
        receipts,
        rows,
        rejectedOwner,
        retiredStatus: retired.status,
        settingsSha256: settingsBefore,
        userDataSha256: hash(await readFile(userFile)),
      });
      oldScope = scope;
      oldOwner = opened.owner;
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
