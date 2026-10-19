/** Observe this profile's real process receipt before starting the unchanged Host ready deadline. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export async function waitProfileReady({
  child,
  runtime,
  signal,
  timeoutMs = 45000,
  source,
  readOutput,
  readLaunchLog,
  recordLifecycle = () => {},
  probe,
}) {
  let deadline = source ? undefined : Date.now() + timeoutMs;
  const observed = new Set();
  while (deadline === undefined || Date.now() < deadline) {
    signal?.throwIfAborted();
    if (source && deadline === undefined) {
      try {
        const bytes = await readFile(resolve(runtime, "source-host.json"), "utf8");
        let host;
        try {
          host = JSON.parse(bytes);
        } catch {
          /* An incomplete or malformed receipt grants no startup clock. */
        }
        if (
          bytes !== source.previous &&
          host?.launcherPid === child.pid &&
          Number.isSafeInteger(host.hostPid) &&
          host.hostPid > 0 &&
          host.hostPid !== child.pid &&
          host.status === "running" &&
          host.combination === source.combination &&
          host.core === source.core
        ) {
          deadline = Date.now() + timeoutMs;
          recordLifecycle({
            event: "host-spawn-observed",
            hostPid: host.hostPid,
            startupTimeoutMs: timeoutMs,
          });
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (!observed.has("admission") && source) {
      try {
        await readFile(resolve(runtime, "core-source.json"));
        observed.add("admission");
        recordLifecycle({ event: "admission-passed-observed" });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const output = readOutput();
    const log = await readLaunchLog();
    const launch = [...log.matchAll(/dsh web: (http[^\s]+)(?=\r?\n)/g)].at(-1)?.[1];
    if (launch && deadline !== undefined) {
      const remaining = Math.max(1, deadline - Date.now());
      const readySignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(remaining),
      ]);
      if (!probe || (await probe(launch, readySignal))) return launch;
    }
    if (child.exitCode !== null || child.signalCode !== null)
      throw Error("Profile exited: " + output);
    // Leave another observation before a short startup deadline, without extending it.
    const interval =
      deadline === undefined ? 50 : Math.min(50, Math.max(1, (deadline - Date.now()) / 2));
    await delay(interval, undefined, { signal });
  }
  throw Error("Profile not ready: " + readOutput());
}

/** Prove local routes are installed without refreshing identity or issuing business reads. */
export async function probeProfileBusiness(origin, cookie, signal, fetcher = fetch) {
  const response = await fetcher(origin + "/api/gea-proof/api-log/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin },
    body: "{}",
    signal,
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return false;
  }
  if (response.status !== 200)
    throw new Error("GEA business readiness failed: HTTP " + response.status);
  const result = await response.json();
  // Guest and read-only policy errors also prove the business handler is installed.
  if (
    result?.ok !== true &&
    !(result?.ok === false && typeof result.error?.code === "string" && result.error.code)
  )
    throw new Error("GEA business readiness failed: invalid response");
  return true;
}
