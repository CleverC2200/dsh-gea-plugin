import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_ACK_FIELD,
  WELCOME_NOTICE_VERSION,
} from "../../../../official-latest-standard/packages/client/ui-settings-models/src/onboarding-copy.ts";

const attached = new WeakMap();
export const welcomeObserver = (page) => attached.get(page);

/** Observe only public welcome settings RPCs, never save whole settings or auth. */
export function startWelcomeObserver(page, origin, directory) {
  if (!isAbsolute(directory)) throw Error("WELCOME_OBSERVER_REQUIRES_ABSOLUTE_EXTERNAL_DIR");
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const events = [];
  let dropped = 0;
  let pendingResponses = 0;
  let closed = false;
  const push = (kind, fields = {}) => {
    if (closed) return;
    if (events.length === 160) { events.shift(); dropped++; }
    events.push({ kind, at: new Date().toISOString(), ms: performance.now() - start, ...fields });
  };
  const scalar = (value) => value === null || typeof value === "boolean" ||
    typeof value === "number" || (typeof value === "string" && value.length <= 64)
    ? value : { type: typeof value, omitted: true };
  const rpcId = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value)
    ? value : null;
  const code = (value) => typeof value === "string" && /^[a-z0-9_/.:-]{1,96}$/i.test(value)
    ? value : null;
  const namespace = (value) => ({
    namespacePresent: !!value,
    namespace: WELCOME_NOTICE_SETTINGS_NAMESPACE,
    revision: typeof value?.revision === "number" ? value.revision : null,
    ackPresent: !!value?.value && Object.hasOwn(value.value, WELCOME_NOTICE_ACK_FIELD),
    ackExactValue: scalar(value?.value?.[WELCOME_NOTICE_ACK_FIELD]),
    acknowledged: value?.value?.[WELCOME_NOTICE_ACK_FIELD] === WELCOME_NOTICE_VERSION,
  });
  const reply = (value) => ({
    rpcId: rpcId(value?.rpcId), resultOk: typeof value?.result?.ok === "boolean" ? value.result.ok : null,
    resultCode: code(value?.result?.error?.code),
    ...namespace(value?.result?.value?.ns === WELCOME_NOTICE_SETTINGS_NAMESPACE
      ? value.result.value
      : (Array.isArray(value?.result?.value?.namespaces)
        ? value.result.value.namespaces.find((entry) => entry?.ns === WELCOME_NOTICE_SETTINGS_NAMESPACE)
        : undefined)),
  });
  const request = (value) => {
    const args = value?.payload?.args;
    const op = args?.ns === WELCOME_NOTICE_SETTINGS_NAMESPACE
      ? (Array.isArray(args.ops) ? args.ops.find((entry) => Array.isArray(entry?.path) && entry.path.length === 1 && entry.path[0] === WELCOME_NOTICE_ACK_FIELD) : undefined)
      : undefined;
    return { rpcId: rpcId(value?.rpcId),
      namespace: args?.ns === WELCOME_NOTICE_SETTINGS_NAMESPACE ? args.ns : null,
      revision: typeof args?.expectedRevision === "number" ? args.expectedRevision : null,
      ackOperation: op?.op === "set" || op?.op === "unset" ? op.op : null,
      ackExactValue: scalar(op?.value) };
  };
  const endpoint = (req) => {
    const url = new URL(req.url());
    if (url.origin !== new URL(origin).origin || req.method() !== "POST") return null;
    return ["/api/settings/describe", "/api/settings/mutate"].includes(url.pathname)
      ? url.pathname : null;
  };
  const onRequest = (req) => {
    const method = endpoint(req);
    if (!method) return;
    try { push("browser-request", { method, ...request(req.postDataJSON()) }); }
    catch { push("browser-request-projection-unavailable", { method }); }
  };
  const onResponse = (response) => {
    const method = endpoint(response.request());
    if (!method) return;
    push("browser-response-headers", { method, httpStatus: response.status() });
    pendingResponses++;
    void response.json().then(
      (value) => push("browser-response-json", { method, httpStatus: response.status(), ...reply(value) }),
      () => push("browser-response-json-unavailable", { method, httpStatus: response.status() }),
    ).finally(() => { pendingResponses--; });
  };
  const onFailed = (req) => {
    const method = endpoint(req);
    if (method) push("browser-request-failed", { method });
  };
  const observer = {
    mark: push,
    request: (id) => push("original-poll-request", { method: "/api/settings/describe", rpcId: rpcId(id) }),
    response: (id, status) => push("original-poll-response-headers", { rpcId: rpcId(id), httpStatus: status }),
    read: (value) => push("original-poll-response-json", reply(value)),
    async stop() {
      push("observer-stop", { pendingResponseBodies: pendingResponses });
      closed = true;
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
      attached.delete(page);
      const file = join(directory, "welcome-" + randomUUID() + ".json");
      try {
        await writeFile(file, JSON.stringify({ startedAt, endedAt: new Date().toISOString(),
          capacity: 160, dropped, pendingResponseBodies: pendingResponses,
          note: "No extended wait; uncompleted response bodies remain UNKNOWN.", events }, null, 2) + "\n",
          { flag: "wx", mode: 0o600 });
        return { captureStatus: "saved", file };
      } catch { return { captureStatus: "unknown" }; }
    },
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  attached.set(page, observer);
  push("observer-attached");
  return observer;
}
