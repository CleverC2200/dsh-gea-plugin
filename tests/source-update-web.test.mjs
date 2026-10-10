/** Real current profile activation uses local metadata-only candidate versions and loopback services. */
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { profile, readSession, readToolResults, until } from "./profile.mjs";
import { openWorkbenchPage, htmlFrameElement } from "./fixtures/business-page.mjs";
import { installStockRoutes, stockState } from "./fixtures/branch-stock.mjs";
import { readDeployment } from "../scripts/deployment.mjs";
import {
  prepareSourcePlugins,
  mergeSourceComponents,
  sourceComponent,
  selectSourceCombination,
} from "../scripts/source-profile.mjs";
import { applySourceUpdate, readSourceUpdateBaseline } from "../scripts/source-update.mjs";

const _project = resolve(import.meta.dirname, "../../../.."),
  core = resolve("../../official-latest-standard");
const parent = resolve(".runtime/ticket-10"),
  gea = "@cleverc2200/gea-dsh-prototype",
  workbench = "@cleverc2200/dsh-agent-workbench";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await fs.readFile(path, "utf8"));

test(
  "real profiles load merged component updates and keep history through restart and guarded recovery",
  { skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 600000, sourceSetupCount: 4 },
  async (t) => {
    await fs.mkdir(parent, { recursive: true });
    let base, baseline, proposalA, proposalB;
    const app = await profile(t, {
      normalStartup: true,
      runtimeParent: parent,
      preserveRuntime: true,
      config: (endpoint) => ({
        analysis: {
          mode: "model",
          baseUrl: endpoint + "/v1",
          model: "fixture",
          apiKeyEnv: "GEA_TEST_MODEL_KEY",
          agentCode: "branch-inventory",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { GEA_TEST_MODEL_KEY: "fixture-key" },
      beforeStart: async ({ runtime, config, credentialEnv }) => {
        await fs.mkdir(join(runtime, "home/profiles/plugin-split-validation"), {
          recursive: true,
        });
        base = await prepareSourcePlugins(
          core,
          runtime,
          await readDeployment(config, { credentialEnv }),
          {
            sources: JSON.parse(await fs.readFile(process.env.GEA_TEST_SOURCE_INPUTS, "utf8")),
          },
        );
        const baseRecordFile = join(runtime, "source-combinations", base.id, "combination.json"),
          baseRecord = await json(baseRecordFile);
        const workbenchVersion = baseRecord.composition.dependencies[workbench]
          .split("-")[0]
          .split(".")
          .map(Number);
        workbenchVersion[2]++;
        const plannedWorkbench = workbenchVersion.join(".");
        // This loopback fixture explicitly declares its unchanged code compatible with the test manifest version.
        for (const accepted of Object.values(baseRecord.compatibility))
          accepted.workbench.push(plannedWorkbench);
        await fs.writeFile(baseRecordFile, JSON.stringify(baseRecord, null, 2));
        await selectSourceCombination(runtime, base.id, core);
        baseline = await readSourceUpdateBaseline(runtime, core);
      },
    });
    async function prepareChannel(runtime) {
      const channel = join(runtime, "simulated-channel");
      await fs.mkdir(channel);
      const proposals = [];
      for (const name of [gea, workbench]) {
        const candidate = await mergeSourceComponents(runtime, base.id, {}, core);
        const directory = join(runtime, "source-combinations", candidate.id),
          record = await json(join(directory, "combination.json")),
          plugins = await json(join(directory, "company-plugins.json"));
        const pkgFile = join(directory, "node_modules", name, "package.json"),
          pkg = await json(pkgFile),
          version = pkg.version.split("-")[0].split(".").map(Number);
        version[2]++;
        pkg.version = version.join(".") + (name === workbench ? "" : "-local.10");
        record.composition.dependencies[name] = pkg.version;
        plugins[name].version = pkg.version;
        const pkgBytes = JSON.stringify(pkg, null, 2) + "\n",
          metadataBytes = JSON.stringify(plugins, null, 2);
        await fs.writeFile(pkgFile, pkgBytes);
        await fs.writeFile(join(directory, "company-plugins.json"), metadataBytes);
        record.files[`node_modules/${name}/package.json`] = digest(pkgBytes);
        record.files["company-plugins.json"] = digest(metadataBytes);
        await fs.writeFile(join(directory, "combination.json"), JSON.stringify(record, null, 2));
        const actual = sourceComponent(record, plugins, name),
          artifact = join(channel, name === gea ? "gea.json" : "workbench.json"),
          bytes = JSON.stringify({
            combination: candidate.id,
            package: name,
            manifestSha256: digest(await fs.readFile(join(directory, "combination.json"))),
          });
        await fs.writeFile(artifact, bytes);
        proposals.push({
          kind: "current-source-update-v1",
          source: pathToFileURL(join(channel, "catalog.json")).href,
          baseline,
          releases: [
            {
              package: name,
              version: actual.version,
              sha256: actual.sha256,
              source: actual.source,
              downloadSha256: digest(bytes),
              url: pathToFileURL(artifact).href,
              compatible: {
                core: [baseline.core],
                interface: "current-unified-v2",
                workbench: [],
              },
            },
          ],
        });
      }
      const workbenchVersions = [
        baseline.components[workbench].version,
        proposals[1].releases[0].version,
      ];
      for (const proposal of proposals)
        proposal.releases[0].compatible.workbench = workbenchVersions;
      [proposalA, proposalB] = proposals;
      await fs.writeFile(
        join(channel, "catalog.json"),
        JSON.stringify(
          {
            kind: "local-current-source-fixture",
            proposals,
            note: "Only package manifest versions change; shipped behavior stays the accepted current interface.",
          },
          null,
          2,
        ),
      );
    }
    const state = stockState();
    installStockRoutes(app, state, (body) => {
      const index = body.messages.findLastIndex((message) => message.role === "user"),
        tools = body.messages.slice(index + 1).filter((message) => message.role === "tool");
      if (!tools.length)
        return {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: {
                name: "gea_cube_query",
                arguments: JSON.stringify({
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
                }),
              },
            },
          ],
        };
      assert.match(tools.map((value) => value.content).join("\n"), /100/);
      return { content: "本地分仓样本100件和30件，合计130件。" };
    });
    const browser = await chromium.launch({
      headless: true,
    });
    t.after(() => browser.close());
    const userFile = join(app.runtime, "workspace/user.txt");
    await fs.writeFile(userFile, "ticket10 retained data");
    const rows = [],
      updates = [];
    let session, priorRows, history;
    for (const phase of ["baseline", "gea-updated", "both-updated", "restored"]) {
      if (phase !== "baseline") {
        await app.stop();
        if (phase === "gea-updated" || phase === "both-updated") {
          if (phase === "gea-updated") {
            await prepareChannel(app.runtime);
            t.signal.throwIfAborted();
          }
          const proposal = phase === "gea-updated" ? proposalA : proposalB;
          const result = await applySourceUpdate(app.runtime, proposal, {
            core,
          });
          assert.equal(result.phase, "succeeded", JSON.stringify(result.failed));
          updates.push(result);
          if (phase === "gea-updated") {
            const late = await applySourceUpdate(app.runtime, proposalA, {
              core,
            });
            assert.equal(late.failed[0].error, "STALE_SOURCE_UPDATE");
            updates.push(late);
          }
          history = result.after.history;
        } else {
          await assert.rejects(
            selectSourceCombination(app.runtime, base.id, core, {
              expected: baseline,
            }),
            /STALE_SOURCE_RECOVERY/,
          );
          await selectSourceCombination(app.runtime, base.id, core, {
            expected: await readSourceUpdateBaseline(app.runtime, core),
          });
        }
        await app.start();
        assert.deepEqual(
          await readSession(app.runtime, session),
          priorRows,
          "restart preserves existing Session rows",
        );
        assert.deepEqual(
          (await readSourceUpdateBaseline(app.runtime, core)).history,
          history,
          "startup keeps immutable release history",
        );
      }
      await app.login();
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
      await page.goto(app.origin);
      await openWorkbenchPage(page, "分仓库存");
      const frame = htmlFrameElement(page, "inventory-fc").contentFrame();
      await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
      if (!session) {
        const created = await app.remote("session/create", {
          cwd: join(app.runtime, "workspace"),
          agentPreset: "gea-html-inventory-fc",
        });
        assert.equal(created.ok, true);
        session = created.value.sessionId;
      }
      assert.equal(
        (
          await app.remote("session/selectModel", {
            sessionId: session,
            provider: "gea-analysis",
            model: "fixture",
          })
        ).ok,
        true,
      );
      const count = (await readSession(app.runtime, session)).filter(
        (row) => row.type === "turn/end",
      ).length;
      assert.equal(
        (
          await app.remote("session/prompt", {
            sessionId: session,
            requestId: randomUUID(),
            mode: "queue",
            content: [{ type: "text", text: "读取分仓库存 " + phase }],
          })
        ).ok,
        true,
      );
      priorRows = await until(
        () => readSession(app.runtime, session),
        (rows) => rows.filter((row) => row.type === "turn/end").length > count,
        60000,
      );
      const receipt = readToolResults(priorRows).at(-1);
      assert.equal(receipt.isError, false);
      assert.match(receipt.text, /100/);
      assert.match(JSON.stringify(priorRows), /合计130件/);
      const actual = await readSourceUpdateBaseline(app.runtime, core);
      assert.equal(
        actual.components[gea].version,
        ["gea-updated", "both-updated"].includes(phase)
          ? proposalA.releases[0].version
          : baseline.components[gea].version,
      );
      assert.equal(
        actual.components[workbench].version,
        phase === "both-updated"
          ? proposalB.releases[0].version
          : baseline.components[workbench].version,
      );
      assert.equal(await fs.readFile(userFile, "utf8"), "ticket10 retained data");
      const modules = await fs.realpath(
        join(app.runtime, "home/profiles/plugin-split-validation/node_modules"),
      );
      assert.equal(modules, join(app.runtime, "source-combinations", actual.id, "node_modules"));
      const pageSource = await fs.readFile(
          join(modules, workbench, "lib/business/inventory-fc/index.html"),
          "utf8",
        ),
        script = pageSource.match(/<script>([\s\S]*)<\/script>/)[1];
      assert.ok(
        (
          await frame
            .locator("script")
            .evaluateAll((scripts) => scripts.map((value) => value.textContent))
        ).includes(script),
      );
      await page.screenshot({
        path: join(parent, phase + ".png"),
        fullPage: true,
      });
      rows.push({
        phase,
        actual,
        session,
        rowCount: priorRows.length,
        receipt,
        modules,
        pageScriptSha256: digest(script),
        userDataSha256: digest(await fs.readFile(userFile)),
      });
      await fs.writeFile(
        join(parent, "acceptance-progress.json"),
        JSON.stringify({ runtime: app.runtime, rows, updates }, null, 2),
      );
      await context.close();
    }
    await app.stop();
    await fs.writeFile(
      join(parent, "acceptance.json"),
      JSON.stringify({ runtime: app.runtime, rows, updates }, null, 2),
    );
  },
);
