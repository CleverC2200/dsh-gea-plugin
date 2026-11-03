import type {
  DesktopUpdateBridge,
  DesktopUpdatePresentation,
} from "@deepseek-ai/dsh-client-ui-settings-general/types";

type Carrier = {
  protocolVersion: number;
  appVersion?: () => Promise<string>;
  updates?: DesktopUpdateBridge;
};

export function createDesktopUpdates() {
  const carrier = (globalThis as typeof globalThis & { dshDesktop?: Carrier }).dshDesktop;
  const bridge = carrier?.protocolVersion === 1 ? carrier.updates : undefined;
  let snapshot: {
    supported: boolean;
    current?: string;
    versionFailed: boolean;
    presentation?: DesktopUpdatePresentation;
    failed: boolean;
    opening: boolean;
  } = {
    supported: bridge !== undefined,
    versionFailed: false,
    failed: false,
    opening: false,
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
    open: async () => {
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
        await bridge.open();
      } catch {
        publish({ failed: true });
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
