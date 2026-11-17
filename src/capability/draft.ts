import { LAYER_POLICY } from "./layers.ts";

export type DraftEffect = "draft" | "submit" | "approve";

export type DraftRequest = {
  sessionId: string;

  surface: string;

  kind: string;
  targets: readonly string[];
  effect: DraftEffect;
  reason?: string;
};

export type DraftReceiptOutcome = "pending" | "applied" | "rejected" | "timeout" | "failed";

export type DraftReceipt = {
  id: string;
  at: number;
  sessionId: string;
  surface: string;
  kind: string;
  targets: string[];
  effect: DraftEffect;
  reason?: string;
  outcome: DraftReceiptOutcome;
  error?: string;
  durationMs?: number;
};

export type DraftBeginResult =
  | { ok: true; receiptId: string }
  | { ok: false; code: string; reason: string };

export type DraftLayerOptions = {
  windowMs?: number;

  maxPerWindow?: number;

  maxReceipts?: number;
  now?: () => number;
  id?: () => string;
};

export type DraftLayer = {
  begin(request: DraftRequest): DraftBeginResult;
  finish(
    receiptId: string,
    outcome: { applied: boolean; error?: string; timedOut?: boolean },
  ): DraftReceipt | undefined;

  receipts(): readonly DraftReceipt[];

  lastFor(sessionId: string): DraftReceipt | undefined;
};

let receiptSeq = 0;

export function createDraftLayer(options: DraftLayerOptions = {}): DraftLayer {
  const now = options.now ?? (() => Date.now());
  const nextId = options.id ?? (() => "draft-" + ++receiptSeq);

  const windowMs = options.windowMs ?? 60_000;
  const maxPerWindow = options.maxPerWindow ?? LAYER_POLICY.draft.maxPerMinute;
  const maxReceipts = options.maxReceipts ?? 200;
  const receipts: DraftReceipt[] = [];

  const stamps = new Map<string, number[]>();

  return {
    begin(request) {
      const at = now();
      const key = request.sessionId + ":" + request.surface;
      const recent = (stamps.get(key) ?? []).filter((stamp) => at - stamp < windowMs);
      if (recent.length >= maxPerWindow) {
        stamps.set(key, recent);
        return {
          ok: false,
          code: "DRAFT_RATE_LIMITED",
          reason: "这一屏短时间内改动太频繁，先停一下再改。",
        };
      }
      recent.push(at);
      stamps.set(key, recent);
      const receipt: DraftReceipt = {
        id: nextId(),
        at,
        sessionId: request.sessionId,
        surface: request.surface,
        kind: request.kind,
        targets: [...request.targets],
        effect: request.effect,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        outcome: "pending",
      };
      receipts.unshift(receipt);
      if (receipts.length > maxReceipts) receipts.length = maxReceipts;
      return { ok: true, receiptId: receipt.id };
    },

    finish(receiptId, outcome) {
      const receipt = receipts.find((entry) => entry.id === receiptId);
      if (!receipt) return undefined;
      receipt.outcome = outcome.timedOut
        ? "timeout"
        : outcome.applied
          ? "applied"
          : outcome.error === undefined
            ? "rejected"
            : "failed";
      if (outcome.error !== undefined) receipt.error = outcome.error;
      receipt.durationMs = now() - receipt.at;
      return receipt;
    },

    receipts: () => receipts,
    lastFor: (sessionId) => receipts.find((receipt) => receipt.sessionId === sessionId),
  };
}
