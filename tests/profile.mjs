/** Product tests own the Web process and replace only external HTTP services. */
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer } from "node:https";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { readSessionRows } from "../scripts/session-log.mjs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readDeployment } from "../scripts/deployment.mjs";
import { freezeProfileWindow } from "./fixtures/profile-window.mjs";
import { withSourceSetup } from "./fixtures/source-test.mjs";
import { waitProfileReady, probeProfileBusiness } from "./fixtures/profile-ready.mjs";
import { fixtureCubeDiscovery } from "./fixtures/cube-wire.mjs";

const defaultRoot = resolve(import.meta.dirname, "..");
/** Decode persisted tool receipts at the test boundary; never omit a malformed result. */
export function readToolResults(rows) {
  return rows
    .filter((row) => row.type === "tool/result")
    .map((row) => {
      const message = row.data.message;
      const result =
        message.role === "tool"
          ? message
          : message.content.find((block) => block.type === "tool-result");
      assert.ok(result && Array.isArray(result.content), "Tool receipt must carry content");
      assert.equal(
        result.toolCallId,
        message.source.callId,
        "Tool receipt call identity must match its source",
      );
      return {
        callId: result.toolCallId,
        isError: result.isError === true,
        text: result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n"),
      };
    });
}
export async function readSession(runtime, id) {
  return (await readSessionRows(runtime, id)) ?? [];
}
export async function until(read, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await delay(30);
  }
  throw new Error("Condition not reached: " + JSON.stringify(value).slice(-2500));
}
export async function profile(t, options = {}) {
  return withSourceSetup(t, () => createProfile(t, options));
}
async function createProfile(t, options) {
  t.signal?.throwIfAborted();
  const root = options.pluginRoot ?? defaultRoot;
  const sourcesFile = options.sourcesFile ?? process.env.GEA_TEST_SOURCE_INPUTS;
  if (process.env.GEA_TEST_SOURCE_CORE === "1" && resolve(root) !== defaultRoot)
    throw new Error(
      "SOURCE_TEST_REQUIRES_CURRENT_CHECKOUT: packaged artifacts use the installed-runtime test lane",
    );
  const runtimeParent =
    options.runtimeParent ?? (options.coreOnly ? resolve(root, ".runtime/core-tests") : tmpdir());
  await mkdir(runtimeParent, { recursive: true });
  const dir = await mkdtemp(resolve(runtimeParent, "gea-profile-"));
  const key = resolve(dir, "key.pem"),
    cert = resolve(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const lifecycleStarted = performance.now();
  const recordLifecycle = (value) => {
    if (process.env.GEA_TEST_LIFECYCLE_RECEIPT)
      appendFileSync(
        process.env.GEA_TEST_LIFECYCLE_RECEIPT,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          elapsedMs: performance.now() - lifecycleStarted,
          testName: t.name,
          directory: dir,
          ...value,
        }) + "\n",
        { mode: 0o600 },
      );
  };
  recordLifecycle({ event: "temporary-directory-created" });
  const recordAbort = () => recordLifecycle({ event: "fixture-aborted" });
  t.signal?.addEventListener("abort", recordAbort, { once: true });
  const requests = [];
  let route = options.route;
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (req, res) => {
      const body = [];
      for await (const part of req) body.push(part);
      const request = {
        url: new URL(req.url, "https://localhost"),
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(body).toString(),
      };
      requests.push(request);
      res.setHeader("Content-Type", "application/json");
      const reply = (value, status = 200) => {
        if (!res.destroyed) {
          res.statusCode = status;
          res.end(JSON.stringify(value));
        }
      };
      try {
        if (await route?.(request, res, reply)) return;
        if (fixtureCubeDiscovery(request, res, reply)) return;
        const path = request.url.pathname;
        if (path.endsWith("/getLoginQrcode"))
          reply({ success: true, result: { qrcodeId: "fixture-qr" } });
        else if (path.endsWith("/getQrcodeToken"))
          reply({
            success: true,
            result: { success: true, token: "fixture-gea-token" },
          });
        else if (path.endsWith("/aiportal/agent/market"))
          reply({
            success: true,
            code: 200,
            result: [
              {
                id: "market-base",
                agentCode: "base-safety-stock",
                agentName: "基地库存",
                businessDomain: "inventory",
              },
              {
                id: "market-sales",
                agentCode: "sales_forecast",
                agentName: "销售计划",
                businessDomain: "plan",
              },
              {
                id: "market-branch",
                agentCode: "branch-inventory",
                agentName: "分仓库存",
                businessDomain: "inventory",
              },
              {
                id: "market-chain",
                agentCode: "full-chain-inventory",
                agentName: "全链库存工作台",
                businessDomain: "inventory",
              },
            ],
          });
        else if (path.endsWith("/sys/dict/getDictItems/business_domain"))
          reply({
            success: true,
            code: 0,
            result: [
              { value: "plan", text: "计划管理", description: null },
              { value: "inventory", text: "库存管理", description: null },
            ],
          });
        else if (path.endsWith("/getUserInfo"))
          reply({
            success: true,
            result: {
              userInfo: {
                id: "9007199254740993",
                realname: "测试用户",
                loginTenantId: "0",
              },
            },
          });
        else if (path.endsWith("/ai/gateway/session")) {
          const { consumerType, consumerCode, conversationId } = JSON.parse(request.body);
          reply({
            success: true,
            code: 200,
            result: {
              accessDecision: { allowed: true },
              delegationToken: "fixture-delegation",
              gatewayContext: {
                sessionId: "SES-fixture",
                consumerType,
                consumerCode,
                conversationId,
              },
            },
          });
        } else if (path.endsWith("/ai/gateway/agent/session"))
          reply({
            success: true,
            code: 200,
            result: {
              accessDecision: { allowed: true },
              delegationToken: "fixture-delegation",
              gatewayContext: { sessionId: "SES-fixture" },
            },
          });
        else if (path.endsWith("/ai/gateway/agent/session/current-user/resolve")) {
          // 审批身份只认账号角色：默认给"区域审批"，用例可用 roles 覆盖（[] 表示任何节点都不可点）。
          const roles = options.roles ?? [{ code: "sales_plan_region_approver", name: "区域审批" }];
          reply({
            success: true,
            code: 200,
            result: {
              success: true,
              userId: "9007199254740993",
              username: "10006800",
              tenantId: "0",
              realName: "测试用户",
              roleCodes: roles.map((role) => role.code).join(","),
              roleNames: roles.map((role) => role.name).join(","),
              roles,
              departments: [],
            },
          });
        } else if (path.endsWith("/ai/gateway/sql/execute")) {
          const body = JSON.parse(request.body);
          const rows = ["0", "1", "2", "3", "4", "Y"].map((node, level) => ({
            id: level + 1,
            type_code: "Y",
            examine_level: String(level),
            node_num: node,
          }));
          reply({
            success: true,
            code: 200,
            result: {
              requestId: request.headers["x-request-id"],
              operation: "SELECT",
              tables: ["agents_scm_plan_workflow_config"],
              total: rows.length,
              pageNo: body.pageNo,
              pageSize: body.pageSize,
              rows,
            },
          });
        } else if (path.endsWith("/periods"))
          reply({
            success: true,
            result: {
              records: [
                {
                  periodId: "period-1",
                  periodMonth: "2026-09",
                  planTypeCode: "Y",
                  status: "OPEN",
                },
              ],
              total: 1,
              current: 1,
              size: 100,
            },
          });
        else if (path.endsWith("/plans")) {
          res.end(
            '{"success":true,"result":{"records":[{"planId":9007199254740993,"versionId":"version-1","planTypeCode":"Y","status":5,"currentQty":1.2300,"targetQty":2.3400,"currentAmount":10.10,"targetAmount":12.30,"belong_base":"华东","orgName":"组织A","provinceName":"浙江"}],"total":1,"current":1,"size":10}}',
          );
        } else reply({ message: "fixture route absent" }, 404);
      } catch (error) {
        reply({ message: String(error) }, 500);
      }
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `https://127.0.0.1:${server.address().port}`;
  const runtime = options.coreOnly
    ? resolve(root, ".runtime/test-core", randomUUID())
    : resolve(dir, "runtime");
  const config = resolve(dir, "gea.json");
  await writeFile(
    config,
    JSON.stringify({
      geaBaseUrl: base + "/gea",
      pageSize: 10,
      periodPageSize: 100,
      requestTimeoutMs: 2000,
      maxSnapshotBytes: 100000,
      analysis: { mode: "receipt" },
      cubeMcpCodes: { production: "cube", test: "cube" },
      ...(typeof options.config === "function" ? options.config(base) : options.config),
    }),
  );
  let preparation;
  let child,
    childClosed,
    childIsClosed = true,
    output = "",
    cookie = "",
    origin = "";
  async function stop() {
    if (!child || childIsClosed) return;
    const signalTree = (signal) => {
      try {
        if (process.platform === "win32") {
          if (child.exitCode === null && child.signalCode === null)
            execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
            });
        } else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    signalTree("SIGTERM");
    let deadline;
    const timer = setTimeout(() => signalTree("SIGKILL"), 10000);
    try {
      await Promise.race([
        childClosed,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("PROFILE_SHUTDOWN_TIMEOUT: runtime preserved")),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
    }
  }
  t.after(async () => {
    t.signal?.removeEventListener("abort", recordAbort);
    let stopped = false;
    const errors = [];
    try {
      await preparation?.catch(() => {});
      await stop();
      stopped = true;
    } catch (error) {
      errors.push(error);
    }
    try {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      let host;
      try {
        host = JSON.parse(await readFile(resolve(runtime, "source-host.json"), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      recordLifecycle({
        event: "process-cleanup",
        wrapperPid: child?.pid,
        wrapperExited: childIsClosed,
        host,
      });
      if (stopped && !options.preserveRuntime) {
        await rm(dir, { recursive: true, force: true });
        if (options.coreOnly) await rm(runtime, { recursive: true, force: true });
        recordLifecycle({ event: "temporary-directory-removed" });
      }
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "PROFILE_CLEANUP_FAILED", { cause: errors[0] });
  });
  async function start() {
    t.signal?.throwIfAborted();
    recordLifecycle({ event: "preparation-started" });
    const fixture = JSON.parse(await readFile(config, "utf8"));
    if (Object.values(fixture.serviceAccounts ?? {}).some((account) => account.keychainService))
      throw new Error("SOURCE_TEST_REQUIRES_FIXTURE_CREDENTIALS");
    const deployment = await readDeployment(config, {
      resolveCredentials: false,
      credentialEnv: options.env ?? {},
    });
    for (const endpoint of [
      deployment.geaBaseUrl,
      ...Object.values(deployment.geaEnvironments ?? {}),
      deployment.analysis.baseUrl,
    ].filter(Boolean))
      if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname))
        throw new Error("SOURCE_TEST_REQUIRES_LOOPBACK_SERVICES");
    const admitted = options.desktopGraph
      ? undefined
      : await (preparation = freezeProfileWindow({
          directory: dir,
          runtime,
          config,
          deployment,
          sourcesFile: options.coreOnly ? undefined : sourcesFile,
          caseName: t.name,
          coreOnly: options.coreOnly,
          signal: t.signal,
          recordLifecycle,
        }));
    t.signal?.throwIfAborted();
    recordLifecycle({ event: "preparation-frozen" });
    output = "";
    let logOffset = 0;
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    try {
      logOffset = (await readFile(resolve(runtime, "server.log"), "utf8")).length;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let previousHost;
    try {
      previousHost = await readFile(resolve(runtime, "source-host.json"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    t.signal?.throwIfAborted();
    child = spawn(
      options.executablePath ?? process.execPath,
      [
        ...(process.platform !== "win32"
          ? ["--import", new URL("./fixtures/profile-parent-lifetime.mjs", import.meta.url).href]
          : []),
        ...(options.execArgv ?? []),
        ...(!options.desktopGraph && !options.normalStartup
          ? [
              resolve(defaultRoot, "tests/source-profile-start.mjs"),
              config,
              runtime,
              options.coreOnly ? "native-only" : "source-host",
              admitted.request,
            ]
          : options.desktopGraph
            ? [resolve(defaultRoot, "desktop/runtime-start.mjs")]
            : [
                "scripts/start.mjs",
                "--window",
                admitted.window.file,
                "--case",
                admitted.window.case,
                "--owner",
                admitted.window.owner,
                "--freeze-sha256",
                admitted.window.freezeSha256,
                "--config",
                config,
                "--runtime",
                runtime,

                "--port",
                options.reusePort && origin ? new URL(origin).port : "0",
              ]),
      ],
      {
        cwd: root,
        detached: process.platform !== "win32",
        // 测试里不挂浏览器 MCP：每次启动都拉 npx + Chrome 会拖慢并让并发用例超时。
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: cert,
          GEA_BROWSER_MCP: "0",
          ...(options.desktopGraph
            ? {
                DSH_PLUGIN_GRAPH: options.desktopGraph,
                DSH_FULL_DATA_DIR: runtime,
                GEA_CONFIG: config,
                DSH_FULL_PORT: "0",
                DSH_FULL_NO_OPEN: "1",
              }
            : {}),
          ...options.env,
          ...(sourcesFile ? { GEA_TEST_SOURCE_INPUTS: sourcesFile } : {}),
        },
        stdio:
          process.platform === "win32"
            ? ["ignore", "pipe", "pipe"]
            : ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    recordLifecycle({ event: "wrapper-spawned", wrapperPid: child.pid });
    childIsClosed = false;
    childClosed = new Promise((done, reject) => {
      child.once("close", () => {
        childIsClosed = true;
        done();
      });
      child.once("error", reject);
    });
    void childClosed.catch(() => {});
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        output += data;
        if (process.env.GEA_TEST_SOURCE_CORE === "1" && !options.desktopGraph)
          appendFileSync(resolve(runtime, "server.log"), data, { mode: 0o600 });
      });
    const source =
      process.env.GEA_TEST_SOURCE_CORE === "1" && !options.desktopGraph
        ? { combination: admitted.combination, core: admitted.core, previous: previousHost }
        : undefined;
    let authenticatedLaunch;
    const launch = await waitProfileReady({
      child,
      runtime,
      signal: t.signal,
      timeoutMs: options.startupTimeoutMs ?? 45000,
      source,
      readOutput: () => output,
      readLaunchLog: async () => {
        if (options.desktopGraph || process.env.GEA_TEST_SOURCE_CORE === "1") return output;
        try {
          return (await readFile(resolve(runtime, "server.log"), "utf8")).slice(logOffset);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          return "";
        }
      },
      recordLifecycle,
      probe: async (url, readySignal) => {
        const currentOrigin = new URL(url).origin;
        if (authenticatedLaunch !== url) {
          const exchange = await fetch(url, { redirect: "manual", signal: readySignal });
          cookie = exchange.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
          if (!cookie) throw new Error("Launch authentication failed");
          authenticatedLaunch = url;
        }
        if (options.coreOnly) return true;
        // Core can expose its URL before Manage's asynchronous services are installed.
        return probeProfileBusiness(currentOrigin, cookie, readySignal);
      },
    });
    origin = new URL(launch).origin;
    recordLifecycle({ event: "host-ready", origin });
    t.signal?.throwIfAborted();
  }
  const api = {
    dir,
    runtime,
    requests,
    base,
    get origin() {
      return origin;
    },
    get cookie() {
      return cookie;
    },
    get output() {
      return output;
    },
    route(fn) {
      route = fn;
    },
    start: () => withSourceSetup(t, start),
    stop,
    async rpc(endpoint, payload = {}) {
      const response = await fetch(origin + "/api/gea-proof/" + endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
        },
        body: JSON.stringify(payload),
      });
      if (response.status !== 200) {
        const diagnostic = output
          .slice(-12000)
          .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer <REDACTED>")
          .replace(/((?:token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1<REDACTED>");
        throw new Error(`HTTP ${response.status} at ${endpoint}\nProfile startup: ${diagnostic}`);
      }
      return response.json();
    },
    async remote(endpoint, request) {
      const response = await fetch(origin + "/api/" + endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
        },
        body: JSON.stringify({
          type: "client-request",
          rpcId: randomUUID(),
          method: endpoint,
          payload: { args: { request } },
        }),
      });
      if (!response.ok)
        throw new Error("Remote HTTP " + response.status + ": " + (await response.text()));
      return (await response.json()).result;
    },
    async login() {
      const qr = await api.rpc("login/start");
      if (!qr.ok) throw new Error(JSON.stringify(qr));
      return api.rpc("login/poll", { loginId: qr.value.loginId });
    },
  };
  await (preparation = Promise.resolve(
    options.beforeStart?.({ runtime, config, credentialEnv: options.env ?? {} }),
  ));
  await start();
  recordLifecycle({ event: "fixture-actions-available" });
  return api;
}
