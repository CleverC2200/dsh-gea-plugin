import type {
  DesktopUpdateBridge,
  DesktopUpdatePresentation,
} from "@deepseek-ai/dsh-client-ui-settings-general/types";

type Carrier = {
  protocolVersion: number;
  appVersion?: () => Promise<string>;
  updates?: DesktopUpdateBridge & {
    check?: () => Promise<DesktopUpdatePresentation>;
    open(version?: string): Promise<void>;
  };
};

export function createDesktopUpdates() {
  const carrier = (globalThis as typeof globalThis & { dshDesktop?: Carrier }).dshDesktop;
  const bridge = carrier?.protocolVersion === 1 ? carrier.updates : undefined;
  let snapshot: {
    supported: boolean;
    canCheck: boolean;
    current?: string;
    versionFailed: boolean;
    presentation?: DesktopUpdatePresentation;
    failed: boolean;
    opening: boolean;
    checked: boolean;
  } = {
    supported: bridge !== undefined,
    canCheck: typeof bridge?.check === "function",
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
    open: async (version?: string) => {
      if (
        !live ||
        !bridge ||
        snapshot.opening ||
        (snapshot.presentation &&
          ["checking", "downloading", "verifying", "installing"].includes(
            snapshot.presentation.phase,
          ))
      )
        return;
      publish({ opening: true });
      try {
        await bridge.open(version);
      } catch {
        publish({ failed: true });
        throw Error("UPDATE_NATIVE_OPEN_FAILED");
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
