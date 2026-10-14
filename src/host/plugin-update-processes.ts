import { watch, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { PluginUpdateOperation } from "../shared/plugin-update-state.ts";
type Observation = PluginUpdateOperation["processes"][number];
function alive(target: number): "alive" | "gone" | "unknown" {
  try {
    process.kill(target, 0);
    return "alive";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH"
      ? "gone"
      : "unknown";
  }
}
function birth(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}
/** Observe the public runner's durable run record. A missing record is not a stopped-tree proof. */
export async function observeProfilePackageProcesses(profile: string) {
  const directory = join(profile, ".plugin-manager"),
    filename = join(directory, "run.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const observations = new Map<number, Observation>();
  let unreliable = false;
  function capture() {
    try {
      const raw: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (
        raw === null ||
        typeof raw !== "object" ||
        !("pid" in raw) ||
        !("grouped" in raw) ||
        typeof raw.pid !== "number" ||
        !Number.isSafeInteger(raw.pid) ||
        raw.pid <= 0 ||
        typeof raw.grouped !== "boolean"
      ) {
        unreliable = true;
        return;
      }
      const old = observations.get(raw.pid),
        startIdentity = old?.startIdentity ?? birth(raw.pid);
      const isAlive =
        raw.grouped &&
        process.platform !== "win32" &&
        alive(-raw.pid) === "alive" &&
        alive(raw.pid) === "alive";
      observations.set(raw.pid, {
        pid: raw.pid,
        grouped: raw.grouped,
        startIdentity,
        sawAlive: old?.sawAlive === true || isAlive,
      });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        unreliable = true;
    }
  }
  const watcher = watch(directory, capture);
  const timer = setInterval(capture, 10);
  timer.unref();
  const snapshot = () => [...observations.values()].map((row) => ({ ...row }));
  function knownGone() {
    return (
      !unreliable &&
      observations.size > 0 &&
      [...observations.values()].every(
        (row) =>
          row.grouped &&
          row.startIdentity !== null &&
          row.sawAlive &&
          process.platform !== "win32" &&
          alive(-row.pid) === "gone" &&
          alive(row.pid) === "gone",
      )
    );
  }
  async function waitForQuiescence(waitMs: number) {
    const deadline = Date.now() + waitMs;
    do {
      capture();
      if (knownGone()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return false;
  }
  function cancelObserved() {
    for (const row of observations.values()) {
      if (
        !row.grouped ||
        !row.sawAlive ||
        !row.startIdentity ||
        process.platform === "win32"
      )
        continue;
      const current = birth(row.pid);
      if (current !== null && current !== row.startIdentity) continue;
      try {
        process.kill(-row.pid, "SIGKILL");
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        )
          unreliable = true;
      }
    }
  }
  return {
    capture,
    snapshot,
    waitForQuiescence,
    cancelObserved,
    close() {
      clearInterval(timer);
      watcher.close();
    },
  };
}
