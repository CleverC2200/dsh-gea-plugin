import { setTimeout as delay } from "node:timers/promises";

function successfulRows(value: unknown): value is { rows: Record<string, unknown>[] } {
  return (
    !!value &&
    typeof value === "object" &&
    "rows" in value &&
    Array.isArray(value.rows) &&
    value.rows.every((row) => row && typeof row === "object" && !Array.isArray(row)) &&
    !("success" in value && value.success === false) &&
    !("failure" in value && value.failure) &&
    !("error" in value && value.error) &&
    !(
      "rejectedColumns" in value &&
      Array.isArray(value.rejectedColumns) &&
      value.rejectedColumns.length
    )
  );
}

/** An unavailable snapshot is distinct from a successful business quantity of zero. */
export function unavailableInventorySnapshot(value: unknown, requireSnapshotDate = true) {
  if (!successfulRows(value)) return false;
  return (
    !value.rows.length ||
    value.rows.every(
      (row) =>
        !Object.values(row).some((cell) => cell !== null && cell !== undefined && cell !== ""),
    ) ||
    (requireSnapshotDate &&
      value.rows.some((row) =>
        ["day", "snapshot_date"].some(
          (key) =>
            Object.hasOwn(row, key) &&
            (row[key] === null || row[key] === undefined || row[key] === ""),
        ),
      ))
  );
}

/** Only a successful but unavailable initialization snapshot gets one bounded follow-up. */
export async function recoverInventorySnapshot<T>(read: () => Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  const result = await read();
  signal.throwIfAborted();
  if (!unavailableInventorySnapshot(result)) return result;
  await delay(750, undefined, { signal });
  signal.throwIfAborted();
  const recovered = await read();
  signal.throwIfAborted();
  return recovered;
}

/** Memory-only snapshots belong to one verified identity epoch. */
export class InventoryReadCache {
  private scope?: AbortSignal;
  private readonly entries = new Map<string, { at: number; value: unknown }>();
  private readonly now: () => number;
  constructor(now = Date.now) {
    this.now = now;
  }

  private activate(scope: AbortSignal) {
    scope.throwIfAborted();
    if (this.scope === scope) return;
    this.entries.clear();
    this.scope = scope;
    scope.addEventListener(
      "abort",
      () => {
        if (this.scope === scope) {
          this.entries.clear();
          this.scope = undefined;
        }
      },
      { once: true },
    );
  }

  get(scope: AbortSignal, key: string, freshAfter: number) {
    this.activate(scope);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.at < freshAfter || this.now() - entry.at >= 20 * 60 * 1000) {
      this.entries.delete(key);
      return undefined;
    }
    return structuredClone(entry.value);
  }

  set(scope: AbortSignal, key: string, value: unknown, requireSnapshotDate = false) {
    this.activate(scope);
    // Failed/cropped responses never become a reusable business snapshot.
    if (!successfulRows(value) || unavailableInventorySnapshot(value, requireSnapshotDate)) return;
    this.entries.delete(key);
    while (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { at: this.now(), value: structuredClone(value) });
  }
}
