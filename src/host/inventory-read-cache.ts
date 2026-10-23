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

  set(scope: AbortSignal, key: string, value: unknown) {
    this.activate(scope);
    // Failed/cropped responses never become a reusable business snapshot.
    if (
      !value ||
      typeof value !== "object" ||
      !("rows" in value) ||
      !Array.isArray(value.rows) ||
      ("success" in value && value.success === false) ||
      ("failure" in value && value.failure) ||
      ("rejectedColumns" in value &&
        Array.isArray(value.rejectedColumns) &&
        value.rejectedColumns.length)
    )
      return;
    this.entries.delete(key);
    while (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { at: this.now(), value: structuredClone(value) });
  }
}
