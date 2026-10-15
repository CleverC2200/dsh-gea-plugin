import { randomUUID } from "node:crypto";
import type { ApiBatchRequest, ApiBatchRun } from "@cleverc2200/dsh-agent-workbench/api-log";
import { GeaApiLogCenter } from "./api-log.ts";
import { DebugRunCoordinator } from "./debug-run.ts";

export function parseApiBatchRequest(payload: Record<string, unknown>): ApiBatchRequest {
  if (
    Object.keys(payload).some((key) => !["items", "confirmedWriteIds"].includes(key)) ||
    !Array.isArray(payload.items) ||
    !payload.items.length ||
    !Array.isArray(payload.confirmedWriteIds)
  )
    throw Error("INVALID_API_BATCH");
  const items = payload.items.map((value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("catalogId" in value) ||
      typeof value.catalogId !== "string" ||
      !("recordId" in value) ||
      (value.recordId !== null && typeof value.recordId !== "string") ||
      Object.keys(value).some((key) => !["catalogId", "recordId"].includes(key))
    )
      throw Error("INVALID_API_BATCH");
    return { catalogId: value.catalogId, recordId: value.recordId };
  });
  const confirmedWriteIds = payload.confirmedWriteIds.map((id: unknown) => {
    if (typeof id !== "string") throw Error("INVALID_API_BATCH");
    return id;
  });
  if (
    new Set(items.map((item) => item.catalogId)).size !== items.length ||
    new Set(confirmedWriteIds).size !== confirmedWriteIds.length ||
    confirmedWriteIds.some((id) => !items.some((item) => item.recordId === id))
  )
    throw Error("INVALID_API_BATCH");
  return { items, confirmedWriteIds };
}

export class ApiLogBatch {
  private readonly runs: {
    scope: string;
    run: ApiBatchRun;
    controller: AbortController;
  }[] = [];
  constructor(
    private readonly log: GeaApiLogCenter,
    private readonly coordinator: DebugRunCoordinator,
  ) {}
  start(
    input: ApiBatchRequest,
    scope: string,
    identity: AbortSignal,
    caller: AbortSignal,
  ): ApiBatchRun {
    caller.throwIfAborted();
    identity.throwIfAborted();
    const catalog = this.log.catalog();
    if (
      input.items.length > catalog.length ||
      input.items.some((item) => !catalog.some((entry) => entry.id === item.catalogId))
    )
      throw Error("INVALID_API_BATCH_CATALOG");
    const controller = new AbortController();
    const run: ApiBatchRun = {
      runId: randomUUID(),
      source: "api-batch",
      startedAt: new Date().toISOString(),
      status: "running",
      items: input.items.map((item) => ({ ...item, status: "queued" })),
    };
    const release = this.coordinator.claim(run.runId);
    this.runs.push({ scope, run, controller });
    const active = AbortSignal.any([controller.signal, identity, caller]);
    void this.execute(run, input.confirmedWriteIds, active).finally(() => {
      release();
      const ended = this.runs.filter((entry) => entry.run.status !== "running");
      for (const obsolete of ended.slice(0, Math.max(0, ended.length - 20)))
        this.runs.splice(this.runs.indexOf(obsolete), 1);
    });
    return structuredClone(run);
  }
  read(runId: string | undefined, scope: string): ApiBatchRun | ApiBatchRun[] {
    const owned = this.runs.filter((entry) => entry.scope === scope);
    if (!runId) return structuredClone(owned.map((entry) => entry.run));
    const target = owned.find((entry) => entry.run.runId === runId);
    if (!target) throw Error("API_BATCH_NOT_FOUND");
    return structuredClone(target.run);
  }
  stop(runId: string, scope: string): ApiBatchRun {
    const target = this.runs.find((entry) => entry.scope === scope && entry.run.runId === runId);
    if (!target) throw Error("API_BATCH_NOT_FOUND");
    target.controller.abort();
    return structuredClone(target.run);
  }
  private async execute(run: ApiBatchRun, confirmed: string[], signal: AbortSignal): Promise<void> {
    try {
      for (const item of run.items) {
        if (signal.aborted) break;
        const reason = this.log.batchSampleRejection(
          item.catalogId,
          item.recordId,
          item.recordId !== null && confirmed.includes(item.recordId),
        );
        if (reason) {
          item.status = "skipped";
          item.reason = reason;
          continue;
        }
        item.status = "running";
        try {
          const result = await this.log.replay(
            item.recordId!,
            confirmed.includes(item.recordId!),
            signal,
            { source: "api-batch", runId: run.runId },
          );
          item.status = result.outcome === "rejected" ? "skipped" : result.outcome;
          if (result.recordId) item.logRecordId = result.recordId;
          if ("reason" in result) item.reason = result.reason;
          if ("resultUnknown" in result) item.resultUnknown = result.resultUnknown;
        } catch (error) {
          item.status = signal.aborted ? "not-run" : "skipped";
          item.reason = (error instanceof Error ? error.message : "重发被拒绝") + "，无调用日志";
        }
      }
    } finally {
      for (const item of run.items)
        if (item.status === "queued") {
          item.status = "not-run";
          item.reason = "已停止，未执行";
        }
      run.status = signal.aborted ? "stopped" : "ended";
      run.endedAt = new Date().toISOString();
    }
  }
}
