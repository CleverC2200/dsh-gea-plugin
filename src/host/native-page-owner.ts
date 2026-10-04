import { randomUUID } from "node:crypto";
import type { Business } from "./business.ts";
import type { PageToolRegistry } from "../page-bridge/registry.ts";

/** The mounted Native workbench owns declarations until its exact connection closes. */
export function createNativePageOwner(
  business: Business,
  tools: PageToolRegistry,
) {
  const owners = new Map<string, { lease: string; scope: string }>();
  const release = (sessionId: string) => {
    owners.delete(sessionId);
    tools.dispose(sessionId);
    business.clearVisibleWorkbenchContext(sessionId);
    business.clearSurface(sessionId, "gea-proof");
  };
  const assert = (sessionId: string, lease: unknown) => {
    const owner = owners.get(sessionId);
    if (
      !owner ||
      owner.lease !== lease ||
      owner.scope !== business.pageSessionScope()
    )
      throw Error("NATIVE_PAGE_OWNER_RELEASED");
  };
  return {
    open(sessionId: string, input: { menu?: unknown; title?: unknown }) {
      const scope = business.pageSessionScope();
      if (!business.status().authenticated || !scope)
        throw Error("PAGE_REFERENCE_LOGIN_REQUIRED");
      if (owners.has(sessionId)) release(sessionId);
      const surface = business.setSurface(sessionId, input);
      if (surface.menu !== "gea-proof") return { ...surface };
      const lease = randomUUID();
      owners.set(sessionId, { lease, scope });
      return { ...surface, lease };
    },
    poll(
      sessionId: string,
      lease: unknown,
      catalog: unknown,
      messages: unknown,
    ) {
      assert(sessionId, lease);
      tools.declare(sessionId, catalog, "self-report");
      return business.pullPageBridgeEvents(sessionId, messages);
    },
    context(
      sessionId: string,
      lease: unknown,
      context: Record<string, unknown> | null,
    ) {
      if (context === null) {
        // A delayed close from an old iframe cannot remove the replacement owner.
        if (typeof lease === "string" && owners.get(sessionId)?.lease === lease)
          release(sessionId);
        return { synced: false };
      }
      assert(sessionId, lease);
      business.updateVisibleWorkbenchContext(sessionId, context);
      return { synced: true };
    },
    assert,
    dispose(sessionId: string) {
      if (owners.has(sessionId)) release(sessionId);
      else tools.dispose(sessionId);
    },
    disposeAll() {
      for (const sessionId of [...owners.keys()]) release(sessionId);
    },
  };
}
