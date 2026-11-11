import type {
  DesktopUpdateBridge,
  DesktopUpdatePresentation,
} from "@deepseek-ai/dsh-client-ui-settings-general/types";

export type RestartUpdateRequest =
  | { kind: "desktop"; version: string }
  | { kind: "plugins"; plans: { packageName: string; planId: string }[] }
  | { kind: "plugins-restart" };

type Carrier = {
  protocolVersion: number;
  appVersion?: () => Promise<string>;
  updates?: DesktopUpdateBridge & {
    check?: () => Promise<DesktopUpdatePresentation>;
    open(version?: string): Promise<void>;
    restartUpdate?: (request: RestartUpdateRequest) => Promise<void>;
  };
};

export function createDesktopUpdates() {
  const carrier = (globalThis as typeof globalThis & { dshDesktop?: Carrier }).dshDesktop;
  const bridge = carrier?.protocolVersion === 1 ? carrier.updates : undefined;
  let snapshot: {
    supported: boolean;
    canCheck: boolean;
    canRestartUpdate: boolean;
    current?: string;
    versionFailed: boolean;
    presentation?: DesktopUpdatePresentation;
    failed: boolean;
    opening: boolean;
    checked: boolean;
  } = {
    supported: bridge !== undefined,
    canCheck: typeof bridge?.check === "function",
    canRestartUpdate: typeof bridge?.restartUpdate === "function",
    versionFailed: false,
    failed: false,
    opening: false,
    checked: false,
  };
  const listeners = new Set<() => void>();
  let live = true,
    received = false;
  const publish = (patch: Partial<typeof snapshot>) => {
    if (!live) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const off = bridge?.subscribe((presentation) => {
    received = true;
    publish({ presentation, failed: false });
  });
  void bridge?.status().then(
    (presentation) => {
      if (!received) publish({ presentation });
    },
    () => {
      if (!received) publish({ failed: true });
    },
  );
  if (carrier?.protocolVersion === 1 && carrier.appVersion) {
    void carrier.appVersion().then(
      (current) => {
        publish(
          typeof current === "string" && current.trim() ? { current } : { versionFailed: true },
        );
      },
      () => publish({ versionFailed: true }),
    );
  } else publish({ versionFailed: true });
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check: async () => {
      if (!bridge?.check) throw Error("UPDATE_CHECK_UNAVAILABLE");
      try {
        const presentation = await bridge.check();
        publish({
          presentation,
          failed: false,
          checked: presentation.phase !== "error",
        });
        return presentation;
      } catch (error) {
        publish({ failed: true, checked: false });
        throw error;
      }
    },
    restartUpdate: async (request: RestartUpdateRequest) => {
      if (!bridge?.restartUpdate) throw Error("UPDATE_TAKEOVER_UNSUPPORTED");
      publish({ opening: true });
      try {
        await bridge.restartUpdate(request);
      } catch (error) {
        publish({ failed: true });
        throw error;
      } finally {
        publish({ opening: false });
      }
    },
    dispose: () => {
      live = false;
      off?.();
      listeners.clear();
    },
  };
}
