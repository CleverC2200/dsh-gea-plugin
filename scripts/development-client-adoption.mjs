import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (data) => createHash("sha256").update(data).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const modulePath = "lib/runtime/skill-directories.js";
const changed = new Set([modulePath, "lib/types/runtime/skill-directories.d.ts"]);

export function retainedPayloadDigest(root) {
  const manifest = read(join(root, "package.json"));
  const files = new Set(["package.json"]);
  const visit = (path) => {
    if (!fs.existsSync(path)) return;
    const info = fs.lstatSync(path);
    if (info.isSymbolicLink()) throw Error("CLIENT_PAYLOAD_LINK");
    if (info.isDirectory()) for (const name of fs.readdirSync(path)) visit(join(path, name));
    else files.add(relative(root, path));
  };
  for (const entry of manifest.files) visit(join(root, entry));
  const digest = createHash("sha256");
  for (const file of [...files].sort())
    if (!changed.has(file))
      digest.update(JSON.stringify([file, hash(fs.readFileSync(join(root, file)))]));
  return digest.digest("hex");
}

async function clientTransport(root) {
  const [port, browser] = fs
    .readFileSync(join(root, "sessionData/DevToolsActivePort"), "utf8")
    .trim()
    .split("\n");
  if (!/^\d+$/.test(port)) throw Error("CLIENT_DEBUG_PORT_UNKNOWN");
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
  ).json();
  const target = targets.find(
    (target) => target.type === "page" && target.url.startsWith("dsh-app://app/"),
  );
  if (!target) throw Error("CLIENT_PAGE_UNAVAILABLE");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let serial = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  ws.onclose = () => {
    for (const resolve of pending.values()) resolve({ closed: true });
    pending.clear();
  };
  const evaluate = async (expression) => {
    const result = await new Promise((resolve) => {
      pending.set(++serial, resolve);
      ws.send(
        JSON.stringify({
          id: serial,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (result.closed) return null;
    if (result.result?.exceptionDetails || result.error) throw Error("CLIENT_OPERATION_FAILED");
    return result.result.result.value;
  };
  const rpc = async (method, args) => {
    const body = JSON.stringify({
      type: "client-request",
      rpcId: randomUUID(),
      method,
      payload: { args },
    });
    const result = await evaluate(
      `fetch(${JSON.stringify("api/" + method)},{method:"POST",headers:{"content-type":"application/json"},body:${JSON.stringify(body)}}).then(r=>r.json())`,
    );
    if (!result?.result?.ok) throw Error("CLIENT_RPC_FAILED");
    return result.result.value;
  };
  return { browser, rpc, restart: () => evaluate("dshDesktop.restart()"), close: () => ws.close() };
}

export async function adoptClientSkillFix(file, connect = clientTransport) {
  const record = read(file);
  if (record.status === "completed") return { status: "completed" };
  const transport = await connect(record.clientRoot);
  const packageRoot = join(
    record.clientRoot,
    "home/profiles/desktop/node_modules/dsh-agent-manage",
  );
  const save = () => fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  try {
    const sessions = (await transport.rpc("session/list", { _request: {} })).items;
    const sessionHashes = sessions.map((session) => hash(session.sessionId));
    if (sessions.some((session) => session.running)) return { status: "waiting-in-use" };
    const installed = hash(fs.readFileSync(join(packageRoot, modulePath)));
    if (retainedPayloadDigest(packageRoot) !== record.retainedPayloadSha256)
      throw Error("CLIENT_OTHER_FILES_CHANGED");
    if (
      record.stage === "restarting" &&
      transport.browser !== record.beforeBrowser &&
      installed === record.newModuleSha256
    ) {
      if (!record.sessionHashes.every((id) => sessionHashes.includes(id)))
        throw Error("CLIENT_SESSION_MISSING");
      const snapshots = join(
        record.clientRoot,
        "home/agent-plugins/data/selected-resources.json.skills/snapshots",
      );
      if (!fs.existsSync(snapshots) || !fs.readdirSync(snapshots).length)
        throw Error("CLIENT_CAS_NOT_OBSERVED");
      record.status = "completed";
      record.sessionCount = sessions.length;
      record.snapshotTrees = fs.readdirSync(snapshots).length;
      save();
      return {
        status: "completed",
        sessionCount: record.sessionCount,
        snapshotTrees: record.snapshotTrees,
      };
    }
    if (record.stage === "installing") {
      const result = await transport.rpc("pluginManager/waitForInstall", {
        requestId: record.requestId,
      });
      if (!result || result.error) throw Error("CLIENT_INSTALL_REQUIRES_RECONCILIATION");
      record.stage = "installed";
      save();
    }
    if (!record.stage) {
      if (
        installed !== record.oldModuleSha256 ||
        hash(fs.readFileSync(record.archive)) !== record.archiveSha256
      )
        throw Error("CLIENT_CANDIDATE_CHANGED");
      record.requestId = randomUUID();
      record.stage = "installing";
      record.beforeBrowser = transport.browser;
      record.sessionHashes = sessionHashes;
      save();
      const result = await transport.rpc("pluginManager/installBundle", {
        spec: record.archive,
        options: { enabled: true, requestId: record.requestId },
      });
      if (
        result.error ||
        result.packageResult?.exitCode !== 0 ||
        result.application !== "restart-required"
      )
        throw Error("CLIENT_INSTALL_FAILED");
      record.stage = "installed";
      save();
    }
    if (record.stage === "installed") {
      record.stage = "restarting";
      save();
      await transport.restart();
    }
    return { status: "waiting-for-restart" };
  } finally {
    transport.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  adoptClientSkillFix(process.argv[2])
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.log(JSON.stringify({ status: "retained", reason: "CLIENT_ADOPTION_NOT_CONFIRMED" }));
      process.exitCode = 1;
    });
}
