import { mkdir, writeFile, link, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const pidValid = (pid) => Number.isSafeInteger(pid) && pid > 0;
const tokenPattern = /^[a-f0-9-]{36}$/;
const stagePattern = /^(baseline|staging)-[a-f0-9-]{36}$/;

async function readRecord(path) {
  const file = await open(path, "r").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!file) return null;
  try {
    const bytes = await file.readFile("utf8");
    const { mtimeMs } = await file.stat();
    let owner;
    try {
      owner = JSON.parse(bytes);
    } catch {}
    return { bytes, owner, mtimeMs };
  } finally {
    await file.close();
  }
}

function lockOwner(owner) {
  return (
    pidValid(owner?.pid) &&
    typeof owner.token === "string" &&
    tokenPattern.test(owner.token) &&
    ["write", "maintenance"].includes(owner.purpose) &&
    (owner.workerPid === undefined || pidValid(owner.workerPid)) &&
    (owner.stage === undefined ||
      (typeof owner.stage === "string" && stagePattern.test(owner.stage)))
  );
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function processStillOwnsRecord(pid, mtimeMs) {
  if (!pidExists(pid)) return false;
  let started;
  try {
    if (process.platform === "win32") {
      const { stdout } = await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { windowsHide: true, timeout: 3000 },
      );
      started = Date.parse(stdout.trim());
    } else {
      const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart="], {
        env: { ...process.env, LC_ALL: "C" },
        timeout: 1000,
      });
      started = Date.parse(stdout.trim());
    }
  } catch {}
  if (!pidExists(pid)) return false;
  return !Number.isFinite(started) || started <= Math.ceil(mtimeMs / 1000) * 1000;
}

async function preparationStopped(root, { owner, mtimeMs }) {
  if (await processStillOwnsRecord(owner.pid, mtimeMs)) return false;
  return preparationWorkerStopped(root, owner, mtimeMs);
}

export async function preparationWorkerStopped(root, owner, mtimeMs) {
  if (!lockOwner(owner)) return false;
  if (
    owner.workerPid !== undefined &&
    ((await processStillOwnsRecord(owner.workerPid, mtimeMs)) ||
      (process.platform !== "win32" && pidExists(-owner.workerPid)))
  )
    return false;
  if (!owner.stage) return true;
  const directory = owner.stage.startsWith("baseline-") ? join(root, "..") : root;
  const run = await readRecord(join(directory, owner.stage, ".plugin-manager", "run.json"));
  if (!run) return true;
  const { owner: worker } = run;
  return (
    pidValid(worker?.pid) &&
    typeof worker.grouped === "boolean" &&
    !(await processStillOwnsRecord(worker.pid, run.mtimeMs)) &&
    (process.platform === "win32" || !worker.grouped || !pidExists(-worker.pid))
  );
}

export async function recoverPluginStoreLock(root) {
  const path = join(root, "prepare.lock");
  const record = await readRecord(path);
  if (!record) return "idle";
  if (!lockOwner(record.owner) || !(await preparationStopped(root, record))) return "busy";

  const owner = { pid: process.pid, token: randomUUID(), purpose: "maintenance" };
  const claim = join(root, "claim-" + owner.token);
  await writeFile(claim, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  try {
    let prior = record.owner;
    for (;;) {
      const takeover = join(root, "takeover-" + prior.token);
      try {
        await link(claim, takeover);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const previous = await readRecord(takeover);
        if (!previous) continue;
        if (
          !lockOwner(previous.owner) ||
          (await processStillOwnsRecord(previous.owner.pid, previous.mtimeMs))
        )
          return "busy";
        prior = previous.owner;
        continue;
      }
      try {
        const current = await readRecord(path);
        if (!current) return "idle";
        if (current.bytes !== record.bytes || current.mtimeMs !== record.mtimeMs) return "busy";
        await rm(path, { force: true });
        return "recovered";
      } finally {
        await rm(takeover, { force: true });
      }
    }
  } finally {
    await rm(claim, { force: true });
  }
}

export async function withPluginStoreLock(root, operation, { purpose = "write" } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, token: randomUUID(), purpose };
  const path = join(root, "prepare.lock"),
    claim = join(root, "claim-" + owner.token);
  await writeFile(claim, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await link(claim, path);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const recovery = await recoverPluginStoreLock(root);
        if (recovery !== "busy") continue;
        const holder = await readRecord(path);
        if (!holder) continue;
        if (purpose !== "maintenance" && holder.owner?.purpose === "maintenance" && attempt < 100) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        throw Error("PLUGIN_UPDATE_BUSY");
      }
    }
  } finally {
    await rm(claim, { force: true });
  }
  try {
    return await operation(owner, path);
  } finally {
    const current = await readRecord(path);
    if (current?.owner?.token === owner.token) await rm(path, { force: true });
  }
}
