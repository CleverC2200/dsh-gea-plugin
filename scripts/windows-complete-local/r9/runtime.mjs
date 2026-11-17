import assert from "node:assert/strict";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export async function openNativeLog(path) {
  const stream = createWriteStream(path);
  await once(stream, "open");
  return stream;
}

function assertInventory(inventory, phase) {
  assert.equal(inventory?.status, 200, "R9_INVENTORY_HTTP_REQUIRED");
  assert.equal(inventory.correlated, true, "R9_INVENTORY_CORRELATION_REQUIRED");
  assert.equal(inventory.ok, true, "R9_INVENTORY_RESULT_REQUIRED");
  assert.equal(inventory.gea?.length, 1, "R9_SINGLE_GEA_REQUIRED");
  const entry = inventory.gea[0];
  assert.equal(entry.moduleName, "@cleverc2200/gea-dsh-prototype");
  assert.equal(entry.enabled, true);
  assert.equal(entry.fiberPhase, phase, "R9_RUNTIME_PHASE_CHANGED");
  assert.equal(typeof entry.entryId, "string");
  assert.ok(entry.entryId.length > 0);
}

export function assertObservation(observation, phase, status) {
  assert.equal(Number.isFinite(Date.parse(observation?.observedAt)), true);
  assertInventory(observation.inventory, phase);
  assert.deepEqual(
    observation.routes,
    [
      { path: "/api/gea-html/identity", status },
      { path: "/api/gea/plugin-updates/status", status },
    ],
    "R9_ROUTES_CHANGED",
  );
}

export async function observeStableRuntime({
  readInventory,
  readRoutes,
  phase,
  status,
  timeoutMs = 180000,
  settleMs = 5000,
  pollMs = 200,
}) {
  const observe = async () => ({
    observedAt: new Date().toISOString(),
    inventory: await readInventory(),
    routes: await readRoutes(),
  });
  const deadline = Date.now() + timeoutMs;
  let first;
  while (Date.now() < deadline) {
    const candidate = await observe();
    try {
      assertObservation(candidate, phase, status);
      first = candidate;
      break;
    } catch {
      await delay(pollMs);
    }
  }
  assert.ok(first, "R9_RUNTIME_NOT_READY");
  await delay(settleMs);
  const second = await observe();
  assertObservation(second, phase, status);
  assert.equal(
    second.inventory.gea[0].entryId,
    first.inventory.gea[0].entryId,
    "R9_RUNTIME_OWNER_CHANGED",
  );
  return { first, second, settleMs };
}

export function trackNativeExit(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal, error: null }));
  });
}

async function waitForExit(exited, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function stopNativeProcess({ pid, requestQuit, exited, force, timeoutMs = 20000 }) {
  const started = Date.now();
  let acknowledgement = "pending";
  let requestError = null;
  const request = Promise.resolve()
    .then(requestQuit)
    .then((reply) => {
      if (reply?.exceptionDetails)
        throw Error("R9_QUIT_EVALUATION_FAILED: " + reply.exceptionDetails.text);
      acknowledgement = "acknowledged";
    })
    .catch((error) => {
      acknowledgement =
        error.code === "R9_CDP_CLOSED" ? "connection-closed-before-reply" : "exception";
      if (error.code !== "R9_CDP_CLOSED") requestError = error.message;
    });
  let exit = await waitForExit(exited, timeoutMs);
  const forcedTermination = exit === null;
  let forceError = null;
  if (forcedTermination) {
    try {
      await force();
    } catch (error) {
      forceError = error.message;
    }
    exit = await waitForExit(exited, 10000);
  }
  await Promise.race([request, Promise.resolve()]);
  if (acknowledgement === "pending") acknowledgement = "process-exited-before-reply";
  return {
    pid,
    elapsedMs: Date.now() - started,
    quitAcknowledgement: acknowledgement,
    requestError,
    forcedTermination,
    forceError,
    code: exit?.code ?? null,
    signal: exit?.signal ?? null,
    processError: exit?.error ?? null,
    gracefulExit:
      !forcedTermination && !requestError && exit?.code === 0 && !exit.signal && !exit.error,
  };
}
