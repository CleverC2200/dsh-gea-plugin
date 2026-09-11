/** Product tests own the Web process and replace only external HTTP services. */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { zstdDecompressSync, constants } from "node:zlib";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const defaultRoot = resolve(import.meta.dirname, "..");
export async function readSession(runtime, id) {
  const home = resolve(runtime, "home/sessions");
  let workspaces;
  try {
    workspaces = await readdir(home);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  for (const workspace of workspaces) {
    let compressed;
    try {
      compressed = await readFile(
        resolve(home, workspace, id, "session.v3.jsonl.zstd"),
      );
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    let offset = 0,
      text = "";
    while (offset < compressed.length) {
      const frame = zstdDecompressSync(compressed.subarray(offset), {
        info: true,
        finishFlush: constants.ZSTD_e_flush,
      });
      if (frame.engine.bytesWritten === 0)
        throw new Error("Invalid zstd frame");
      text += frame.buffer.toString();
      offset += frame.engine.bytesWritten;
    }
    return text.trim().split("\n").map(JSON.parse);
  }
  return [];
}
export async function until(read, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await delay(30);
  }
  throw new Error(
    "Condition not reached: " + JSON.stringify(value).slice(-2500),
  );
}
export async function profile(t, options = {}) {
  const root = options.pluginRoot ?? defaultRoot;
  const dir = await mkdtemp(resolve(tmpdir(), "gea-profile-"));
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
  const requests = [];
  let route;
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
        const path = request.url.pathname;
        if (path.endsWith("/getLoginQrcode"))
          reply({ success: true, result: { qrcodeId: "fixture-qr" } });
        else if (path.endsWith("/getQrcodeToken"))
          reply({
            success: true,
            result: { success: true, token: "fixture-gea-token" },
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
        else if (path.endsWith("/periods"))
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
            '{"success":true,"result":{"records":[{"planId":9007199254740993,"versionId":"version-1","planTypeCode":"Y","status":5,"currentQty":1.2300,"targetQty":2.3400,"currentAmount":10.10,"targetAmount":12.30,"baseName":"华东","orgName":"组织A","provinceName":"浙江"}],"total":1,"current":1,"size":10}}',
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
  const runtime = resolve(dir, "runtime");
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
      ...(typeof options.config === "function"
        ? options.config(base)
        : options.config),
    }),
  );
  let child,
    output = "",
    cookie = "",
    origin = "";
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const ended = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    await ended;
    clearTimeout(timer);
  }
  t.after(async () => {
    await stop();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(dir, { recursive: true, force: true });
  });
  async function start() {
    output = "";
    child = spawn(
      process.execPath,
      [
        "scripts/start.mjs",
        "--config",
        config,
        "--runtime",
        runtime,
        "--port",
        "0",
      ],
      {
        cwd: root,
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        output += data;
      });
    const deadline = Date.now() + 45000;
    let launch;
    while (Date.now() < deadline) {
      let log = "";
      try {
        log = await readFile(resolve(runtime, "server.log"), "utf8");
      } catch {
        /* Startup has not opened its log yet. */
      }
      launch = [...log.matchAll(/dsh web: (http[^\s]+)/g)].at(-1)?.[1];
      if (launch && output.includes("dsh web:")) break;
      if (child.exitCode !== null) throw new Error("Profile exited: " + output);
      await delay(50);
    }
    if (!launch) throw new Error("Profile not ready: " + output);
    origin = new URL(launch).origin;
    const exchange = await fetch(launch, { redirect: "manual" });
    cookie = exchange.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    if (!cookie) throw new Error("Launch authentication failed");
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
    start,
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
      if (response.status !== 200) throw new Error("HTTP " + response.status);
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
        throw new Error(
          "Remote HTTP " + response.status + ": " + (await response.text()),
        );
      return (await response.json()).result;
    },
    async login() {
      const qr = await api.rpc("login/start");
      if (!qr.ok) throw new Error(JSON.stringify(qr));
      return api.rpc("login/poll", { loginId: qr.value.loginId });
    },
  };
  await start();
  return api;
}
