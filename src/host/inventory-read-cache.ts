import { setTimeout as delay } from "node:timers/promises";

export function inventoryReadCacheTtl(consumerCode: string): number {
  return (consumerCode === "branch-inventory" ? 5 : 20) * 60 * 1000;
}

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

export function unavailableInventorySnapshot(value: unknown, requireSnapshotDate = true) {
  if (!successfulRows(value)) return false;
  return (
    !value.rows.length ||
    value.rows.every(
      (row) =>
        (Object.hasOwn(row, "page_scope_total") &&
          Number(row.page_scope_total) === 0 &&
          row.page_row_present == null) ||
        (Object.hasOwn(row, "row_count") && Number(row.row_count) === 0),
    ) ||
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

export class InventoryReadCache {
  private readonly pending = new WeakMap<
    AbortSignal,
    Map<
      string,
      {
        controller: AbortController;
        waiters: number;
        settled: boolean;
        promise: Promise<unknown>;
      }
    >
  >();
  private scope?: AbortSignal;
  private readonly entries = new Map<string, { at: number; startedAt: number; value: unknown }>();
  private readonly now: () => number;
  private readonly clone: typeof structuredClone;
  constructor(now = Date.now, clone: typeof structuredClone = structuredClone) {
    this.now = now;
    this.clone = clone;
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

  share(
    scope: AbortSignal,
    key: string,
    caller: AbortSignal,
    read: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> {
    scope.throwIfAborted();
    caller.throwIfAborted();
    let jobs = this.pending.get(scope);
    if (!jobs) this.pending.set(scope, (jobs = new Map()));
    let job = jobs.get(key);
    if (!job) {
      const controller = new AbortController();
      const signal = AbortSignal.any([scope, controller.signal]);
      const entry = {
        controller,
        waiters: 0,
        settled: false,
        promise: Promise.resolve<unknown>(undefined),
      };
      entry.promise = Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return read(signal);
        })
        .finally(() => {
          entry.settled = true;
          if (jobs.get(key) === entry) jobs.delete(key);
        });
      jobs.set(key, entry);
      job = entry;
    }
    const entry = job;
    entry.waiters++;
    const subscription = AbortSignal.any([scope, caller]);
    return new Promise((resolve, reject) => {
      let finished = false;
      const detach = () => {
        if (finished) return false;
        finished = true;
        subscription.removeEventListener("abort", abort);
        entry.waiters--;
        if (!entry.waiters && !entry.settled) {
          if (jobs.get(key) === entry) jobs.delete(key);
          entry.controller.abort();
        }
        return true;
      };
      const abort = () => {
        if (detach()) reject(subscription.reason);
      };
      subscription.addEventListener("abort", abort, { once: true });
      entry.promise.then(
        (value) => {
          if (detach()) resolve(this.clone(value));
        },
        (error) => {
          if (detach()) reject(error);
        },
      );
    });
  }

  get(scope: AbortSignal, key: string, freshAfter: number, maxAgeMs = 20 * 60 * 1000) {
    this.activate(scope);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.startedAt < freshAfter || this.now() - entry.at >= maxAgeMs) {
      this.entries.delete(key);
      return undefined;
    }
    return this.clone(entry.value);
  }

  set(
    scope: AbortSignal,
    key: string,
    value: unknown,
    requireSnapshotDate = false,
    startedAt = this.now(),
  ) {
    this.activate(scope);

    if (!successfulRows(value) || unavailableInventorySnapshot(value, requireSnapshotDate)) return;
    if ((this.entries.get(key)?.startedAt ?? -Infinity) > startedAt) return;
    this.entries.delete(key);
    while (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { at: this.now(), startedAt, value: this.clone(value) });
  }
}
