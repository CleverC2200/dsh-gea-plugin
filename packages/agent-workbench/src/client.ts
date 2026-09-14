/** Layout replacement for unmodified DSH, with native conversation composition. */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { PanelInfo } from "./service.ts";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type { IWorkspaces } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import { WorkbenchController, type AgentWorkbench } from "./workbench.ts";
import { AppFrame } from "./AppFrame.tsx";
import { createLayoutStore } from "./stores.ts";
import { LayoutController } from "./service.ts";
import { ThemePresenter } from "./theme-presenter.ts";
/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = [
  "slots",
  "theme",
  "locale",
  "sessions",
  "remote",
  "remote.session",
  "workspaces",
];

/**
 * Client plugin body: provide ctx.layout, then one register() call — AppFrame
 * into 'root' with the four child-slot declarations, the layout store seat,
 * and the shared root instance supplying commands and the panel-info source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const handle = createLayoutStore();
    const instance = handle.create();
    const store: typeof handle = { ...handle, create: () => instance };
    const layout = new LayoutController(instance.actions, (id) =>
      ctx.slots.entries("main").some((entry) => entry.options.key === id),
    );
    const retainMainPanels = (): void => {
      instance.actions.retainMainPanels(
        ctx.slots
          .entries("main")
          .flatMap((entry) =>
            entry.options.key === undefined ? [] : [entry.options.key],
          ),
      );
    };
    const panelInfo: HostObservable<PanelInfo> = {
      getSnapshot: () => instance.getSnapshot().panelInfo,
      subscribe: (listener) => instance.subscribe(listener),
    };
    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo } });
    const workspaces = ctx.get("workspaces") as unknown as IWorkspaces;
    const sessions = ctx.get("sessions") as unknown as ISessions;
    let storage: Storage | undefined;
    try {
      storage = window.sessionStorage;
    } catch {
      /* Privacy settings can deny browser storage. */
    }
    const workbench = new WorkbenchController({
      storage,
      create: async (preset) => {
        const response = await fetch("/api/agent-workbench/config", {
          credentials: "same-origin",
        });
        if (!response.ok)
          throw new Error(
            `Workbench configuration unavailable: ${response.status}`,
          );
        const config: unknown = await response.json();
        if (
          !config ||
          typeof config !== "object" ||
          !("cwd" in config) ||
          typeof config.cwd !== "string"
        )
          throw new Error("Invalid workbench configuration");
        const workspace = await workspaces.create({ path: config.cwd });
        const result = await ctx.remote.session.create({
          workspaceId: workspace.workspaceId,
          agentPreset: preset,
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.value.sessionId;
      },
      prepare: async (id) => {
        await sessions.refresh();
        if (!sessions.list.getSnapshot().byId[id])
          throw new Error(`Session unavailable: ${id}`);
      },
      available: (id) => sessions.list.getSnapshot().byId[id] !== undefined,
      select: (id) => {
        if (id === undefined) sessions.clear();
        else sessions.open(id);
      },
      panel: (id) => layout.selectPanel(id),
      beginNavigation: () => layout.beginNavigation(),
      showConversation: (id) => layout.registerConversationPanel(id),
    });
    layout.onSelect = (id) => workbench.selectPanel(id);
    const disposeWorkbench = ctx.reflect.provide("agentWorkbench", workbench);
    const disposeService = ctx.reflect.provide("layout", layout);
    const disposeRegistration = ctx.slots.register(
      {
        name: "root",
        locale: "common",
        children: {
          sidebar: { kind: "single", scope: "root" },
          main: { kind: "keyed", scope: "root" },
          rightbar: { kind: "single", scope: "root" },
          "shell.overlay": { kind: "list", scope: "root" },
        },
        store,
      },
      AppFrame,
    );
    const disposePanels = ctx.slots.subscribe("main", retainMainPanels);
    retainMainPanels();
    return () => {
      workbench.dispose();
      layout.dispose();
      disposePanels();
      disposeRegistration();
      disposePanelInfo();
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService();
      void disposeWorkbench();
    };
  }, "ui-layout: service + root registration");

  // Theme presentation: pure DOM writes from resolved snapshots — initial
  // state through the getter once, then event-driven only; no React path.
  ctx.effect(() => {
    const presenter = new ThemePresenter();
    presenter.apply(ctx.theme.getTheme());
    const off = ctx.on("theme/change", (snapshot) => {
      presenter.apply(snapshot);
    });
    return () => {
      off();
      presenter.dispose();
    };
  }, "ui-layout: theme presenter");
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    agentWorkbench: AgentWorkbench;
  }
}
