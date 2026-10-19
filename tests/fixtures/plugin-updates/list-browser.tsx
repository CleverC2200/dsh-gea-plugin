import React, { useState } from "react";
import "@deepseek-ai/dsh-client-ui-theme/src/styles/base.css";
import "@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css";
import { Context } from "@deepseek-ai/cordis";
import * as renderer from "@deepseek-ai/dsh-client-ui-renderer/client";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import * as store from "@deepseek-ai/dsh-client-store";
import * as settings from "@deepseek-ai/dsh-client-ui-settings/client";
import * as manager from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { TestRemote } from "@fixture/remote";
import * as jsxRuntime from "react/jsx-runtime";
import workbenchMeta from "../../../../dsh-agent-workbench/locale/zh.json";
import manageMeta from "../../../../dsh-agent-manage/locale/zh.json";
import geaMeta from "../../../locale/zh.json";

const ctx = new Context();
await ctx.plugin(renderer).await();
const emptyBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };
const binding = { getSnapshot: () => emptyBinding, subscribe: () => () => {} };
ctx.slots.installScope("session", { current: binding, bindingSource: () => binding });
const locale = new LocaleRuntime(ctx);
ctx.provide("locale", locale);
ctx.slots.installLocale(locale);
locale.setLocale("zh");
const names = [
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "@cleverc2200/gea-dsh-prototype",
];
const bundles = [workbenchMeta, manageMeta, geaMeta].map(({ meta }, i) => ({
  name: names[i],
  version: "1.2.3",
  meta,
  installed: true,
  optional: false,
  enabled: true,
  removable: true,
  rows: [],
  overrides: [],
}));
new TestRemote(ctx, {
  settings: {
    describe: async () => ({
      ok: true,
      value: { writable: true, hasDocument: true, namespaces: [] },
    }),
  },
  pluginInventory: {
    list: async () => ({ ok: true, value: { entries: [], managementAvailable: true } }),
  },
  pluginRegistryProbe: { fastest: async () => ({ ok: true, value: null }) },
  pluginManager: {
    listBundles: async () => ({ ok: true, value: bundles }),
    listPlugins: async () => ({ ok: true, value: [] }),
  },
});
await ctx.plugin(settings).await();
let openSettings = () => {};
let closeSettings = () => {};
const openedSections: string[] = [];
ctx.provide("settingsNavigation", {
  open(sectionId) {
    openedSections.push(sectionId);
    openSettings();
  },
});
ctx.slots.register(
  {
    name: "root",
    children: {
      "settings.section": { kind: "list", scope: "root" },
      "shell.overlay": { kind: "list", scope: "root" },
    },
  },
  ({ renderSlot }) => {
    const [visible, setVisible] = useState(true);
    openSettings = () => setVisible(true);
    closeSettings = () => setVisible(false);
    return (
      <div style={{ maxWidth: 800, margin: "auto", padding: 24 }}>
        {visible
          ? renderSlot("settings.section", { close: closeSettings }, { only: "plugin-manager" })
          : null}
        {renderSlot("shell.overlay", {})}
      </div>
    );
  },
);
const core = ctx.plugin({ inject: manager.inject, apply: manager.apply });
await core.await();
ctx.provide("modules", {
  entries: { state: { getSnapshot: () => ({ syncing: true, failures: [] }) } },
});
const platform: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "@deepseek-ai/dsh-client-ui-primitives": primitives,
  "@deepseek-ai/dsh-client-store": store,
};
const built = window.geaFactory((name: string) => {
  if (!(name in platform)) throw Error("Missing client dependency " + name);
  return platform[name];
});
let gea = ctx.plugin(built);
await gea.await();
const unmount = ctx.uiRenderer.mount(document.getElementById("app")!);
Object.assign(window, {
  fixture: {
    closeSettings() {
      closeSettings();
    },
    openedSections,
    async reloadGea() {
      await gea.dispose();
      gea = ctx.plugin(built);
      await gea.await();
    },
    async dispose() {
      unmount();
      await gea.dispose();
      await core.dispose();
      await ctx.fiber.dispose();
    },
  },
});
