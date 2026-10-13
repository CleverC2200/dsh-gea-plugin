/** Temporary diagnostic branch only. Never print credentials, prompts, Sessions or business rows. */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const codes = (text) => [...new Set(String(text ?? "").match(/\b(?:GEA|PAGE|HTML|MOCK|INVALID|UNEXPECTED_FIXTURE|WORKBENCH|SOURCE)_[A-Z0-9_]+\b/g) ?? [])];
const safeText = (value) => {
  const text = String(value ?? "");
  if (/[{}]|prompt|authorization|cookie|credential|password|bearer|token|secret|session/i.test(text))
    return { codes: codes(text), text: "<REDACTED>" };
  return {
    codes: codes(text),
    text: text
      .replace(/https?:\/\/[^\s<>"']+/g, (value) => safeUrl(value))
      .replace(/\bsession-[a-z0-9-]+\b/gi, "<REDACTED>")
      .replace(/\beyJ[A-Za-z0-9_.-]+\b/g, "<REDACTED>")
      .replace(/[A-Za-z0-9_+/-]{40,}/g, "<REDACTED>")
      .slice(0, 400),
  };
};
const safeUrl = (value) => {
  try {
    const url = new URL(value, "http://localhost");
    const result = { origin: url.origin, path: url.pathname };
    if (url.pathname === "/api/agent-workbench/html") {
      result.id = url.searchParams.get("id") === "inventory-fc" ? "inventory-fc" : "<REDACTED>";
      result.page = /^[a-z]{0,24}$/.test(url.searchParams.get("page") ?? "") ? url.searchParams.get("page") : "<REDACTED>";
    }
    return JSON.stringify(result);
  } catch { return "<REDACTED>"; }
};
const id = (value) => typeof value === "string" && /^[a-z][a-z0-9-]{0,119}$/.test(value) ? value : null;
const boolean = (value) => typeof value === "boolean" ? value : null;

export function observeFcProbe(page) {
  const events = [];
  const remember = (event) => { if (events.length < 40) events.push(event); };
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      remember({ kind: "console", type: message.type(), ...( /Error|Failed|Cannot|undefined|not defined|not a function|GEA_|MOCK_|PAGE_|CSP|Content.Security.Policy/i.test(message.text()) ? safeText(message.text()) : { codes: codes(message.text()), text: "<REDACTED>" } ) });
  });
  page.on("pageerror", (error) => remember({ kind: "pageerror", name: error.name, ...safeText(error.message) }));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/api/agent-workbench/html" && url.searchParams.get("id") === "inventory-fc")
      remember({ kind: "html-response", src: safeUrl(response.url()), status: response.status(), contentType: response.headers()["content-type"] ?? null });
  });
  return events;
}

export async function captureFcFailure({ app, page, state, events, replies, initialOpenReply, contexts, failure }) {
  const report = {
    tag: "[CI-FC-PROBE]",
    failure: safeText(failure?.message),
    initialOpenReply: initialOpenReply ? {
      ok: boolean(initialOpenReply.ok),
      ownerPresent: typeof initialOpenReply.owner === "string",
      pageId: id(initialOpenReply.pageId),
      resourceId: id(initialOpenReply.resourceId),
      kind: id(initialOpenReply.kind),
      src: initialOpenReply.src ? safeUrl(initialOpenReply.src) : null,
      binding: { surface: id(initialOpenReply.binding?.surface), tool: typeof initialOpenReply.binding?.tool === "string" && /^[a-z][a-z0-9_-]{0,119}$/.test(initialOpenReply.binding.tool) ? initialOpenReply.binding.tool : null },
      errorCodes: codes(JSON.stringify(initialOpenReply.error ?? null)),
    } : null,
    fixture: { mode: state.mode, sqlRequests: state.rest.length, restConsumers: [...new Set(state.restConsumers)].map(id), cubeRequests: state.cube.length, modelRequests: state.models.length, errorCodes: codes(app.output) },
    context: { count: contexts.length, state: id(contexts.at(-1)?.parts?.queryState?.state), errorCodes: codes(contexts.at(-1)?.parts?.queryState?.message) },
    browserEvents: events,
    fixtureResponses: replies,
  };
  const observe = async (name, fn) => {
    try { report[name] = await fn(); }
    catch (error) { report[name] = { observationError: safeText(error.message) }; }
  };
  let actualIframeSrc;
  await observe("iframe", async () => {
    const result = await page.locator('iframe[src^="/api/agent-workbench/html?id=inventory-fc&"]').evaluateAll((frames) => frames.map((frame) => {
      const style = getComputedStyle(frame);
      return {
        src: frame.getAttribute("src"), sandbox: frame.getAttribute("sandbox"),
        visible: frame.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none",
      };
    }));
    actualIframeSrc = result.find((value) => typeof value.src === "string")?.src;
    const documents = [];
    for (const frame of page.frames()) {
      const url = new URL(frame.url() || "about:blank");
      if (url.pathname !== "/api/agent-workbench/html" || url.searchParams.get("id") !== "inventory-fc") continue;
      // Playwright enters the frame directly; the product sandbox deliberately denies parent DOM access.
      const value = await frame.evaluate(() => ({
        title: document.title, readyState: document.readyState, browserClock: new Date().toISOString(),
        isSecureContext, cssHighlightsType: typeof CSS?.highlights,
        fc001Present: document.body?.innerText.includes("FC001") ?? false,
        fc002Present: document.body?.innerText.includes("FC002") ?? false,
        activeTab: document.querySelector('nav.tabs button[aria-current="page"]')?.textContent?.trim() ?? null,
        businessOnly: [...document.querySelectorAll("label.filter-chip")].find(label => label.textContent?.trim() === "有业务")?.querySelector("input")?.checked ?? null,
        tableBodyRows: document.querySelectorAll("table tbody tr").length,
        errors: (document.body?.innerText ?? "").split("\n").filter((line) => /错误|失败|拒绝|不可用|GEA_|MOCK_|Page unavailable|Error|Failed/i.test(line)).slice(0, 5).map((line) => line.slice(0, 400)),
      }));
      documents.push({ ...value, src: safeUrl(frame.url()), title: safeText(value.title), errors: value.errors.map(safeText) });
    }
    return { elements: result.map((value) => ({ ...value, src: safeUrl(value.src) })), documents };
  });
  const get = async (path) => {
    const response = await page.context().request.get(new URL(path, app.origin).href, { timeout: 2000 });
    return { response, status: response.status(), contentType: response.headers()["content-type"] ?? null };
  };
  await observe("publicHtml", async () => {
    if (!actualIframeSrc) return { source: "no-existing-iframe-src", status: null };
    const target = new URL(actualIframeSrc, app.origin);
    if (target.origin !== app.origin || target.pathname !== "/api/agent-workbench/html" || target.searchParams.get("id") !== "inventory-fc")
      return { source: "existing-iframe-src-outside-probe", status: null };
    const { response, status, contentType } = await get(target.href);
    const text = await response.text();
    return { source: "existing-iframe-src-readback", status, contentType, bytes: Buffer.byteLength(text), errorCodes: codes(text), pageUnavailable: text === "Page unavailable", htmlDocument: /<!doctype html/i.test(text) };
  });
  await observe("registeredPages", async () => {
    const { response, status, contentType } = await get("/api/agent-workbench/pages");
    const value = await response.json();
    return { status, contentType, fc: Array.isArray(value) ? value.filter((item) => item.id === "inventory-fc").map((item) => ({ id: id(item.id), pluginId: id(item.pluginId), resourceId: id(item.resourceId), url: safeUrl(item.url) })) : null, errorCodes: codes(JSON.stringify(value.error ?? null)) };
  });
  await observe("resources", async () => {
    const { response, status, contentType } = await get("/api/agent-manage/resources?" + new URLSearchParams({ cwd: resolve(app.runtime, "workspace") }));
    const value = await response.json();
    return { status, contentType, fc: Array.isArray(value) ? value.filter((item) => item.id === "gea-html-inventory-fc").map((item) => ({ id: id(item.id), kind: id(item.kind), installed: boolean(item.installed), enabled: boolean(item.enabled), availability: id(item.availability) })) : null, errorCodes: codes(JSON.stringify(value.error ?? null)) };
  });
  await observe("geaStatus", async () => {
    const response = await page.context().request.post(new URL("/api/gea-proof/status", app.origin).href, { data: {}, headers: { Origin: app.origin }, timeout: 2000 });
    const reply = await response.json();
    const value = reply.value ?? {};
    return { status: response.status(), ok: boolean(reply.ok), authenticated: boolean(value.authenticated), htmlPlugins: boolean(value.htmlPlugins), readonlyValidationPresent: value.readonlyValidation !== undefined, modules: Array.isArray(value.modules) ? value.modules.filter((item) => item.id === "inventory-fc").map((item) => ({ id: id(item.id), consumerCode: id(item.consumerCode), surface: id(item.surface), pageIds: Array.isArray(item.pageIds) ? item.pageIds.map(id) : null })) : null, errorCodes: codes(JSON.stringify(reply.error ?? null)) };
  });
  await observe("configuredRoots", async () => {
    const patch = parseYaml(await readFile(resolve(app.runtime, "home/profiles/plugin-split-validation/cordis.patch.yml"), "utf8"));
    const roots = patch.find((item) => item.id === "agent-workbench")?.config?.htmlRoots ?? [];
    return Promise.all(roots.map(async (root) => {
      const files = {};
      for (const name of ["index.html", "plugin.json", "page.json", "capability.json", "prompt.json", "mcp.json"])
        try { files[name] = { exists: true, bytes: (await stat(resolve(root, name))).size }; } catch (error) { files[name] = { exists: false, code: error.code }; }
      let capability;
      try {
        const value = JSON.parse(await readFile(resolve(root, "capability.json"), "utf8"));
        capability = { enabled: value.enabled === undefined ? true : boolean(value.enabled), mock: boolean(value.data?.mock), maxEffect: id(value.maxEffect), consumerCode: id(value.data?.consumerCode) };
      } catch (error) { capability = { errorCodes: codes(error.message) }; }
      return { path: root.replace(app.runtime, "<PROFILE_RUNTIME>"), files, capability };
    }));
  });
  await mkdir(".runtime/branch-stock-evidence", { recursive: true });
  await writeFile(".runtime/branch-stock-evidence/ci-fc-probe.json", JSON.stringify(report, null, 2) + "\n");
  console.log("[CI-FC-PROBE] " + JSON.stringify(report));
}

/** Record actual fixture response shape only; never values or SQL. */
export function recordFcReply(replies, request, value, status) {
  if (!request.url.pathname.endsWith("/ai/gateway/sql/execute") || replies.length >= 20) return;
  const rows = value?.result?.rows;
  const identifier = key => typeof key === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,80}$/.test(key) ? key : "<REDACTED>";
  const entry = { status: status ?? 200, rowCount: Array.isArray(rows) ? rows.length : null, firstRowKeys: rows?.[0] && typeof rows[0] === "object" ? Object.keys(rows[0]).map(identifier) : [] };
  const first = rows?.[0];
  if (typeof first?.dsh_columns === "string" && typeof first?.dsh_rows === "string") {
    try {
      const columns = JSON.parse(first.dsh_columns), matrix = JSON.parse(first.dsh_rows);
      if (Array.isArray(columns) && Array.isArray(matrix)) {
        entry.packetColumns = columns.map(identifier);
        entry.packetRowCount = matrix.length;
        entry.packetFirstRowTypes = Array.isArray(matrix[0]) ? matrix[0].map(item => item === null ? "null" : typeof item) : [];
      }
    } catch { entry.packetShapeInvalid = true; }
  }
  replies.push(entry);
}
