import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { serializeReference } from "../packages/page-interaction/src/reference.ts";
const require = createRequire(import.meta.url);

async function renderer(t) {
  const temporary = await mkdtemp(resolve(tmpdir(), "page-reference-render-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const output = resolve(temporary, "display.mjs");
  await build({
    entryPoints: ["packages/page-interaction/src/reference-display.tsx"], outfile: output,
    bundle: true, format: "esm", platform: "node", loader: { ".css": "empty" },
    alias: { "@deepseek-ai/dsh-client-ui-primitives": resolve("../deepseek-harness/packages/client/ui-primitives/src/user-text.tsx") },
    plugins: [{ name: "shared-react", setup(b) { b.onResolve({filter: /^react(?:\/jsx-runtime)?$/}, args => ({path: require.resolve(args.path), external: true})); } }],
  });
  return import(pathToFileURL(output));
}

test("page references render through the native text seat without changing wire text", async t => {
  const { PageReferenceText, installReferenceDisplay } = await renderer(t);
  const label = "销售计划 · 客户[直营]/50%";
  const wire = serializeReference({ id: "R123456abcdef", label }) + "分析这些";
  const html = renderToStaticMarkup(React.createElement(PageReferenceText, { text: wire, sessionLabels: [] }));
  assert.match(html, /data-ref-chip="page"/);
  assert.ok(html.includes(label));
  assert.ok(!html.includes("dsh-page:"));
  assert.ok(wire.includes("dsh-page:R123456abcdef"));
  let registration;
  installReferenceDisplay({ slots: { inject(_key, setup) { return setup(); }, register(options, component) { registration = { options, component }; return () => {}; } } });
  assert.equal(registration.options.name, "conversation.user.text");
  assert.equal(registration.component, PageReferenceText);
});

test("queue previews limit decoded labels instead of cutting their receipt", async t => {
  const { PageReferenceText } = await renderer(t);
  const label = "库存范围/".repeat(20);
  const wire = serializeReference({ id: "R123456abcdef", label });
  const html = renderToStaticMarkup(React.createElement(PageReferenceText, { text: wire, sessionLabels: [], maxLength: 12 }));
  assert.match(html, /data-ref-chip="page"/);
  assert.ok(html.includes(Array.from(label).slice(0,12).join("")));
  assert.ok(html.includes("…"));
  assert.ok(!html.includes("dsh-page:"));
});
