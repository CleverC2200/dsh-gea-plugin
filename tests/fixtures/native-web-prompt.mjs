import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readSupportedCore } from "../../scripts/supported-cores.mjs";

/** Read the admitted Core's public section without starting another Web server. */
export async function nativeWebPrompt(origin) {
  const core = resolve("../../official-latest-standard");
  await readSupportedCore(core);
  const { apply } = await import(pathToFileURL(join(core, "packages/bundle/web-app/lib/index.js")));
  const sections = [];
  const systemPrompt = {
    getSectionOrder: () => 0,
    section: (section) => sections.push(section),
  };
  const webServer = { host: "127.0.0.1", port: Number(new URL(origin).port) };
  const ctx = {
    webServer,
    systemPrompt,
    get: (name) => ({ webServer, systemPrompt })[name],
    provide() {},
    plugin() {},
    inject: (names, fn) => {
      if (names.includes("systemPrompt")) fn(ctx);
    },
  };
  apply(ctx, { trustedHosts: [], openBrowser: false, printUrl: false, surfaceContext: true });
  const section = sections.find((section) => section.name === "app:web-surface");
  assert.ok(section, "the admitted Core must own the Web surface section");
  return section.text();
}

/** Exempt only one exact authoritative Core section; keep all other prompt bytes under review. */
export function withoutNativeWebPrompt(system, native) {
  assert.equal(
    system.split(native).length,
    2,
    "the actual prompt must retain the Core section once",
  );
  return system.replace(native, "");
}
