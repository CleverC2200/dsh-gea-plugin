/** Real fixed Core and real three-plugin runtime; only external services and optional enhancements are fixtures. */
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sourceAssemblyFixture } from "./fixtures/source-assembly.mjs";
import { sourcePlugins } from "../scripts/source-composition.mjs";
import { resourceDigests } from "../scripts/source-profile.mjs";
import { profile, readSession, until } from "./profile.mjs";

// Published assets are a read-only snapshot of this frozen source group. Build
// directories/dependencies stay in their owners; this fixture never builds Core.
async function inputs(t) {
  const input = JSON.parse(await readFile(process.env.GEA_REASONING_INTEGRATION_INPUT, "utf8"));
  const fixture = await sourceAssemblyFixture(t);
  const sources = fixture.sources;
  await mkdir(join(fixture.root, "integration"));
  await symlink(input.officialCorePath, join(fixture.root, "official-latest-standard"), "dir");
  for (const row of input.repositories) {
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: row.path, encoding: "utf8" }).trim(),
      row.head,
    );
    const source =
      row.repo === "dsh-gea-plugin" ? row.path : join(fixture.root, "integration", row.repo);
    if (source === row.path) {
      await symlink(source, join(fixture.root, "integration", row.repo), "dir");
    } else {
      execFileSync("git", [
        "-c",
        "advice.detachedHead=false",
        "clone",
        "-q",
        "--no-hardlinks",
        row.path,
        source,
      ]);
      const sourceUrl = execFileSync("git", ["remote", "get-url", "source"], {
        cwd: row.path,
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["remote", "add", "source", sourceUrl], { cwd: source });
    }
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
      row.head,
    );
    const assets = join(fixture.root, "compiled-" + row.repo);
    await mkdir(assets);
    for (const resource of sourcePlugins.find((x) => x.repo === row.repo).resources) {
      try {
        await cp(join(row.path, resource), join(assets, resource), { recursive: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    Object.assign(
      sources.find((x) => x.repo === row.repo),
      {
        source,
        assets,
        commit: row.head,
        files: await resourceDigests(assets, "", true),
        dependencies: join(row.path, "node_modules"),
      },
    );
    if (row.repo !== "dsh-gea-plugin") row.path = source;
  }
  const file = join(fixture.root, "sources.json");
  await writeFile(file, JSON.stringify(sources));
  const candidate = join(fixture.root, "candidate.json");
  await writeFile(candidate, JSON.stringify(input));
  const previous = process.env.GEA_TEST_CANDIDATE;
  process.env.GEA_TEST_CANDIDATE = candidate;
  t.after(() => {
    if (previous === undefined) delete process.env.GEA_TEST_CANDIDATE;
    else process.env.GEA_TEST_CANDIDATE = previous;
  });
  return file;
}

test(
  "GEA reasoning survives actual Core tool continuation and process restart without repeating a completed tool",
  { timeout: 90000, sourceSetupCount: 2 },
  async (t) => {
    const sourcesFile = await inputs(t);
    const app = await profile(t, {
      sourcesFile,
      config: {
        analysis: {
          mode: "model",
          source: "gea",
          agentCode: "sales_forecast",
          model: "reasoning-fixture",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      },
    });
    const sent = [];
    const thoughts = ["  首轮思考\n先读文件。", "工具之后的最终思考\n", "重启后的思考"];
    app.route((request, response, reply) => {
      const path = request.url.pathname;
      if (path === "/gea/aidata/user-agent-credential/my/list") {
        reply({
          success: true,
          result: { records: [{ id: "credential", status: "ACTIVE" }], total: 1 },
        });
        return true;
      }
      if (path === "/gea/aidata/user-agent-credential/my/claim") {
        reply({
          success: true,
          result: {
            credentialId: "credential",
            status: "ACTIVE",
            baseUrl: app.base + "/personal",
            secret: "fixture-secret",
          },
        });
        return true;
      }
      if (path === "/personal/models") {
        reply({ data: [{ id: "reasoning-fixture", name: "deepseek-v4-flash" }] });
        return true;
      }
      if (path !== "/personal/chat/completions") return false;
      const body = JSON.parse(request.body);
      sent.push(body);
      assert.equal(body.gea_tool_execution_mode, "client");
      assert.equal(request.headers["x-gea-agent-code"], "sales_forecast");
      const n = sent.length;
      response.setHeader("Content-Type", "text/event-stream");
      const event = (delta, finish_reason = null) =>
        "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
      response.write(event({ reasoning_content: thoughts[n - 1] }));
      if (n === 1) {
        assert.ok(
          body.tools.some((x) => x.function.name === "read"),
          "Use a real standard read-only tool",
        );
        response.end(
          event(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "read-once",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({
                      file_path: app.runtime + "/workspace/reasoning-fixture.txt",
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          ) + "data: [DONE]\n\n",
        );
      } else response.end(event({ content: "验收答案" }, "stop") + "data: [DONE]\n\n");
      return true;
    });
    await app.login();
    await app.rpc("model/discover");
    await mkdir(app.runtime + "/workspace", { recursive: true });
    await writeFile(app.runtime + "/workspace/reasoning-fixture.txt", "fixture read result");
    const created = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: "gea-readonly",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const sessionId = created.value.sessionId;
    await app.remote("session/selectModel", {
      sessionId,
      provider: "gea-analysis",
      model: "reasoning-fixture",
    });
    const ask = () =>
      app.remote("session/prompt", {
        sessionId,
        requestId: randomUUID(),
        mode: "queue",
        content: [{ type: "text", text: "读取验收文件后回答" }],
      });
    await ask();
    let rows = await until(
      () => readSession(app.runtime, sessionId),
      (xs) => xs.some((x) => x.type === "turn/end"),
    );
    assert.equal(
      rows.find((x) => x.type === "turn/end").data.reason.kind,
      "completed",
      app.output.slice(-1500),
    );
    assert.equal(sent.length, 2);
    const original = sent[1].messages.find((x) => x.role === "assistant" && x.tool_calls);
    assert.equal(original.reasoning_content, thoughts[0]);
    assert.equal(original.tool_calls[0].id, "read-once");
    assert.equal(sent[1].messages.find((x) => x.role === "tool").tool_call_id, "read-once");
    assert.match(sent[1].messages.find((x) => x.role === "tool").content, /fixture read result/);
    const completed = rows.filter((x) => x.type === "assistant/message");
    assert.deepEqual(
      completed.map((x) => x.data.message.content.find((b) => b.type === "reasoning")?.text),
      thoughts.slice(0, 2),
    );
    await app.stop();
    await app.start();
    await app.login();
    await ask();
    rows = await until(
      () => readSession(app.runtime, sessionId),
      (xs) => xs.filter((x) => x.type === "turn/end").length === 2,
    );
    assert.equal(rows.filter((x) => x.type === "turn/end").at(-1).data.reason.kind, "completed");
    assert.equal(sent.length, 3);
    assert.deepEqual(
      sent[2].messages.filter((x) => x.role === "assistant").map((x) => x.reasoning_content),
      thoughts.slice(0, 2),
    );
    assert.equal(
      rows.filter((x) => x.type === "tool/call" && x.data.callId === "read-once").length,
      1,
    );
  },
);
