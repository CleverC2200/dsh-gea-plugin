import React, { useSyncExternalStore } from "react";
import { DesktopUpdateIndicator } from "@deepseek-ai/dsh-client-ui-settings-general/src/client/DesktopUpdateIndicator.tsx";
import { DesktopUpdateSource } from "@deepseek-ai/dsh-client-ui-settings-general/src/client/desktop-update-source.ts";
import { GeneralSection } from "@deepseek-ai/dsh-client-ui-settings-general/src/client/GeneralSection.tsx";
import "@deepseek-ai/dsh-client-ui-theme/src/styles/base.css";
import "@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css";
import { Context } from "@deepseek-ai/cordis";
import * as renderer from "@deepseek-ai/dsh-client-ui-renderer/client";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import * as store from "@deepseek-ai/dsh-client-store";
import * as jsxRuntime from "react/jsx-runtime";
const ctx = new Context();
const officialUpdates = new DesktopUpdateSource(window.dshDesktop?.updates);
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
ctx.provide("pluginNavigation", { openBundle() {} });
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
      "settings.update": { kind: "single", scope: "root" },
      "settings.section": { kind: "list", scope: "root" },
      "sidebar.footer.action": { kind: "list", scope: "root" },
      "gea.account.actions": { kind: "list", scope: "root" },
      "plugins.detail.badge": { kind: "list", scope: "root" },
      "plugins.detail.section": { kind: "list", scope: "root" },
    },
  },
  ({ renderSlot }) => {
    const view = useSyncExternalStore(
      officialUpdates.store.subscribe,
      officialUpdates.store.getSnapshot,
    );
    return (
      <>
        <div data-official-update>
          {renderSlot(
            "settings.update",
            { wide: true, hidden: false },
            {
              fallback: (
                <DesktopUpdateIndicator
                  wide
                  hidden={false}
                  t={(key) => key}
                  view={view}
                  onOpen={() => officialUpdates.open()}
                />
              ),
            },
          )}
        </div>
        <div data-general-settings>
          {renderSlot("settings.section", { close() {} }, { only: "general" })}
        </div>
        <div data-account-actions>{renderSlot("gea.account.actions", { onSelect() {} })}</div>
        <aside data-update-entry>
          {renderSlot("sidebar.footer.action", {
            wide: !location.search.includes("narrow-entry"),
          })}
        </aside>
        <main>
          {renderSlot("plugins.detail.badge", { subject })}
          {renderSlot("plugins.detail.section", { subject })}
        </main>
      </>
    );
  },
);
ctx.slots.register(
  {
    name: "settings.section",
    id: "general",
    children: { "settings.general.item": { kind: "list", scope: "root" } },
  },
  GeneralSection,
);
ctx.provide("modules", {
  entries: { state: { getSnapshot: () => ({ syncing: true, failures: [] }) } },
});
const platform: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "@deepseek-ai/dsh-client-ui-primitives": primitives,
  "@deepseek-ai/dsh-client-store": store,
};
const factory = (
  window as unknown as {
    geaFactory: (require: (name: string) => unknown) => {
      apply(ctx: Context): void;
      pluginPackageVersion: unknown;
    };
  }
).geaFactory;
const built = factory((name) => {
  if (!(name in platform)) throw Error("Missing built client dependency " + name);
  return platform[name];
});
const geaFiber = ctx.plugin(built);
await geaFiber.await();
const refreshOfficialUpdates = () =>
  officialUpdates.setEnabled(ctx.slots.entries("settings.update").length === 0);
refreshOfficialUpdates();
const releaseOfficialUpdates = ctx.slots.subscribe("settings.update", refreshOfficialUpdates);
const release = () => geaFiber.dispose();
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
    packageVersion: {
      value: built.pluginPackageVersion,
      frozen: Object.isFrozen(built.pluginPackageVersion),
    },
    unmountPlugin: release,
    async dispose() {
      releaseOfficialUpdates();
      officialUpdates.dispose();
      await release();
    },
  },
});
