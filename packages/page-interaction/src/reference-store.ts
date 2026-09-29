import { randomUUID } from "node:crypto";
import {
  pageReference,
  type BoundReference,
  type ReferenceReceipt,
} from "./reference.ts";

/** Immutable, session-local snapshots; the conversation only carries a small receipt. */
export function createReferenceStore() {
  const sessions = new Map<string, Map<string, BoundReference>>();
  return {
    put(input: unknown): ReferenceReceipt {
      const data = input as Partial<BoundReference> | null;
      const snapshot = pageReference(input);
      if (
        !snapshot ||
        typeof data?.sessionId !== "string" ||
        !/^session-[a-z0-9-]+$/i.test(data.sessionId) ||
        typeof data.surface !== "string"
      )
        throw Error("引用无效，请重新选择。");
      const id = "R" + randomUUID().replace(/-/g, "").slice(0, 12);
      const session =
        sessions.get(data.sessionId) ?? new Map<string, BoundReference>();
      session.set(id, {
        ...snapshot,
        sessionId: data.sessionId,
        surface: data.surface.slice(0, 200),
        tool:
          typeof data.tool === "string" ? data.tool.slice(0, 100) : undefined,
      });
      sessions.set(data.sessionId, session);
      return { id, label: `${snapshot.page} · ${snapshot.label}`.slice(0, 72) };
    },
    read(sessionId: string, id: string) {
      const snapshot = sessions.get(sessionId)?.get(id);
      return snapshot
        ? { source: "USER_PAGE_REFERENCE", ...snapshot }
        : {
            error: "REFERENCE_UNAVAILABLE",
            message: "引用已失效，请在当前页面重新选择内容。",
          };
    },
    clear(sessionId: string) {
      sessions.delete(sessionId);
    },
    clearAll() {
      sessions.clear();
    },
    dispose() {
      sessions.clear();
    },
  };
}
