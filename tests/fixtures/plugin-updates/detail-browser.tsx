import React from "react";
import "@deepseek-ai/dsh-client-ui-theme/src/styles/base.css";
import "@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css";
import { Context } from "@deepseek-ai/cordis";
import * as renderer from "@deepseek-ai/dsh-client-ui-renderer/client";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import { mountPluginUpdatesClient } from "../../../src/plugin-detail-updates.tsx";
const ctx = new Context();
await ctx.plugin(renderer).await();
const emptyBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };
const binding = { getSnapshot: () => emptyBinding, subscribe: () => () => {} };
ctx.slots.installScope("session", {
  current: binding,
  bindingSource: () => binding,
});
const locale = new LocaleRuntime(ctx);
ctx.provide("locale", locale);
ctx.slots.installLocale(locale);
let subject = {
  kind: "bundle",
  pkg: {
    name: "@cleverc2200/gea-dsh-prototype",
    installed: true,
    enabled: true,
    rows: [],
  },
};
ctx.slots.register(
  {
    name: "root",
    children: {
      "plugins.detail.actions": { kind: "list", scope: "root" },
      "plugins.detail.badge": { kind: "list", scope: "root" },
      "plugins.detail.section": { kind: "list", scope: "root" },
    },
  },
  ({ renderSlot }) => (
    <main>
      {renderSlot("plugins.detail.actions", { subject })}
      {renderSlot("plugins.detail.badge", { subject })}
      {renderSlot("plugins.detail.section", { subject })}
    </main>
  ),
);
ctx.provide("modules", {
  entries: { state: { getSnapshot: () => ({ syncing: true, failures: [] }) } },
});
const release = mountPluginUpdatesClient(ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
let unmount = ctx.uiRenderer.mount(document.getElementById("app")!);
Object.assign(window, {
  fixture: {
    subject(next: typeof subject) {
      unmount();
      subject = next;
      unmount = ctx.uiRenderer.mount(document.getElementById("app")!);
    },
    close() {
      unmount();
    },
    open() {
      unmount = ctx.uiRenderer.mount(document.getElementById("app")!);
    },
    locale(value: string) {
      locale.setLocale(value);
    },
    async dispose() {
      await release();
    },
  },
});
