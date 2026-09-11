import type { AssistantSurfaceId } from './registry.ts';

const STORAGE_PREFIX = 'gea-dsh:assistant-surface:v1';
const SNAPSHOT_VERSION = 1;

type StoredSnapshot<T> = { version: typeof SNAPSHOT_VERSION; value: T };

const storageKey = (surfaceId: AssistantSurfaceId, scope: string) => `${STORAGE_PREFIX}:${surfaceId}:${scope}`;

export const getAssistantSurfaceWorkbenchScope = (stateScope: string) => `${stateScope}:reference-workbench`;

export const getAssistantSurfaceStateScope = (
  userId: string,
  surfaceId: AssistantSurfaceId,
  fixtureEnvironment: boolean
) => `${userId}:${surfaceId}-${fixtureEnvironment ? 'fixture' : 'live'}-01`;

export const readAssistantSurfaceState = <T>(surfaceId: AssistantSurfaceId, scope: string, fallback: T): T => {
  try {
    const value = window.sessionStorage.getItem(storageKey(surfaceId, scope));
    if (value === null) return fallback;
    const snapshot = JSON.parse(value) as Partial<StoredSnapshot<T>>;
    return snapshot.version === SNAPSHOT_VERSION && 'value' in snapshot ? (snapshot.value as T) : fallback;
  } catch {
    return fallback;
  }
};

export const writeAssistantSurfaceState = <T>(surfaceId: AssistantSurfaceId, scope: string, value: T): void => {
  try {
    const snapshot: StoredSnapshot<T> = { version: SNAPSHOT_VERSION, value };
    window.sessionStorage.setItem(storageKey(surfaceId, scope), JSON.stringify(snapshot));
  } catch {
    // A full or unavailable session store must not prevent the workbench from rendering.
  }
};
