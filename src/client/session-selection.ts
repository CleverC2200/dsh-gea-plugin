import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";

/** The native main-view owner determines which Session receives page context. */
export function selectedSession(snapshot: SessionListState) {
  return Object.values(snapshot.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id;
}
