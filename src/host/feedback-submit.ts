import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-command-feedback";
import type {
  SessionFeedbackSubmitRequest,
  SessionFeedbackSubmitResult,
  SessionFeedbackReportId,
} from "@deepseek-ai/dsh-command-feedback/types";
import { brandString } from "@deepseek-ai/dsh-brand";
import {
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
} from "@deepseek-ai/dsh-session-log-export";
import { zipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginPackageVersion } from "../plugin-package-version.ts";
import type { Business } from "./business.ts";
import type { CaptureIdentity, CaptureMissing } from "./request-capture.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sameOwner = (left: CaptureIdentity, right: CaptureIdentity) =>
  left.base === right.base &&
  left.environment === right.environment &&
  left.userId === right.userId &&
  left.tenantId === right.tenantId;
class FeedbackFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
type PendingFeedback = {
  description: string;
  submissionId: string;
  path: string;
  owner: CaptureIdentity;
};

export class FeedbackSubmitter {
  private readonly pending = new Map<string, PendingFeedback>();
  private readonly active = new Map<
    string,
    { description: string; operation: Promise<SessionFeedbackSubmitResult> }
  >();

  constructor(
    private readonly ctx: Context,
    private readonly business: Business,
    private readonly uploadTimeoutMs = 120000,
    private readonly maxZipBytes = 20 * 1024 * 1024,
  ) {}

  submit(request: SessionFeedbackSubmitRequest): Promise<SessionFeedbackSubmitResult> {
    const sessionId =
      this.business.capture.session(request.sessionId)?.rootSessionId ?? request.sessionId;
    const existing = this.active.get(sessionId);
    if (existing)
      return existing.description === request.description
        ? existing.operation
        : Promise.resolve({
            ok: false,
            error: {
              code: "GEA_FEEDBACK_IN_PROGRESS",
              message: "此会话已有反馈正在提交，请等待完成后再修改描述",
            },
          });
    const operation = this.perform(sessionId, request.description).finally(() =>
      this.active.delete(sessionId),
    );
    this.active.set(sessionId, { description: request.description, operation });
    return operation;
  }

  private async freeze(
    sessionId: string,
    description: string,
    identity: CaptureIdentity,
  ): Promise<PendingFeedback> {
    const captureStartedAt = new Date().toISOString();
    const deps = sessionLogExportDeps(this.ctx);
    if (!deps.sessionPersistence)
      throw new FeedbackFailure(
        "GEA_FEEDBACK_SESSION_LOG_UNAVAILABLE",
        "官方会话日志服务不可用，请稍后重试",
      );
    const id = brandString<SessionFeedbackSubmitRequest["sessionId"]>(sessionId);
    await flushLiveSessionLog(deps, id);
    const official = await readSessionLogText(deps.sessionPersistence, id);
    if (!official)
      throw new FeedbackFailure(
        "GEA_FEEDBACK_SESSION_LOG_UNAVAILABLE",
        "未取得官方会话日志，未提交反馈",
      );
    const header: unknown = JSON.parse(official.split("\n")[0]);
    if (!isRecord(header) || header.version !== 4 || header.id !== sessionId)
      throw new FeedbackFailure("GEA_FEEDBACK_SESSION_FORMAT", "官方会话日志格式与反馈接口不匹配");
    const snapshot = await this.business.capture.snapshot(sessionId);
    const files: Record<string, Uint8Array> = {
      ...snapshot.files,
      "session.v4.jsonl": Buffer.from(official),
    };
    const missing: CaptureMissing[] = [...snapshot.missing];
    const records = this.business.apiLogSnapshot({}).records.filter((entry) => {
      const value = entry.request.headers["x-request-id"];
      return typeof value === "string" && snapshot.requestIds.has(value);
    });
    if (records.length) {
      files["gea-api-logs.jsonl"] = Buffer.from(
        records.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      if (records.length < snapshot.requestIds.size)
        missing.push({
          file: "gea-api-logs.jsonl",
          reason: "部分 API 日志已淘汰、未记录正文或无法取得；完整请求记录以独立清单为准",
        });
    } else missing.push({ file: "gea-api-logs.jsonl", reason: "未取得属于本会话的独立 API 日志" });
    const captureCompletedAt = new Date().toISOString();
    const pack = () => {
      const manifest = {
        formatVersion: 1,
        sessionId,
        clientVersion: process.env.DSH_CLIENT_VERSION ?? pluginPackageVersion.version,
        captureStartedAt,
        captureCompletedAt,
        files: Object.keys(files),
        missing,
      };
      const entries = { "manifest.json": Buffer.from(JSON.stringify(manifest)), ...files };
      const uncompressed = Object.values(entries).reduce(
        (total, bytes) => total + bytes.byteLength,
        0,
      );
      const zip = zipSync(entries, { level: 6 });
      return {
        zip,
        fits:
          zip.byteLength <= this.maxZipBytes &&
          uncompressed <= Math.min(80 * 1024 * 1024, this.maxZipBytes * 4),
      };
    };
    let archive = pack();
    for (const optional of ["gea-api-logs.jsonl", "gea-diagnostics.jsonl"]) {
      if (archive.fits) break;
      if (!files[optional]) continue;
      delete files[optional];
      missing.push({ file: optional, reason: "为满足反馈上传容量限制，本次省略此可选原文文件" });
      archive = pack();
    }
    if (!archive.fits)
      throw new FeedbackFailure(
        "GEA_FEEDBACK_TOO_LARGE",
        "官方日志和请求清单超过反馈容量上限，未提交反馈",
      );
    const submissionId = randomUUID();
    const directory = join(this.business.config.runtimeDir, "feedback-submissions");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, submissionId + ".zip");
    await writeFile(path, archive.zip, { mode: 0o600, flag: "wx" });
    return { description, submissionId, path, owner: { ...identity } };
  }

  private async perform(
    sessionId: string,
    description: string,
  ): Promise<SessionFeedbackSubmitResult> {
    try {
      const owner = this.business.feedbackOwner();
      let pending = this.pending.get(sessionId);
      if (
        !pending ||
        pending.description !== description ||
        !sameOwner(pending.owner, owner.identity)
      ) {
        const previous = pending;
        pending = await this.freeze(sessionId, description, owner.identity);
        owner.signal.throwIfAborted();
        this.pending.set(sessionId, pending);
        if (previous) await unlink(previous.path).catch(() => {});
      }
      const bytes = await readFile(pending.path);
      const body = new FormData();
      body.set("description", pending.description);
      body.set("submissionId", pending.submissionId);
      body.set(
        "file",
        new Blob([new Uint8Array(bytes)], { type: "application/zip" }),
        "feedback.zip",
      );
      const response = await owner.send(body, this.uploadTimeoutMs);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new FeedbackFailure(
          "GEA_FEEDBACK_INVALID_RESPONSE",
          "反馈服务未返回有效回执，请保留原内容重试",
        );
      }
      owner.signal.throwIfAborted();
      const result = isRecord(value) && isRecord(value.result) ? value.result : undefined;
      if (
        !response.ok ||
        !isRecord(value) ||
        value.success !== true ||
        value.code !== 200 ||
        !result ||
        typeof result.reportId !== "string" ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(result.reportId) ||
        typeof result.receivedAt !== "string" ||
        !Number.isFinite(Date.parse(result.receivedAt))
      ) {
        const code =
          isRecord(value) &&
          typeof value.errorCode === "string" &&
          /^[A-Z0-9_]{1,100}$/.test(value.errorCode)
            ? value.errorCode
            : "GEA_FEEDBACK_SUBMIT_FAILED";
        const status =
          isRecord(value) && typeof value.code === "number" && value.code >= 400
            ? value.code
            : response.status;
        const messages: Record<number, string> = {
          400: "反馈材料未通过服务端校验，原包已保留，请联系维护者核对",
          401: "登录已失效，请使用原账号重新登录后重试",
          403: "当前账号无权提交此反馈，请核对用户和租户",
          409: "提交号与已有反馈内容冲突，原包已保留，请联系维护者核对",
          413: "反馈包超过服务端容量限制，原包已保留",
        };
        throw new FeedbackFailure(
          code,
          messages[status] ?? "反馈提交未成功，原内容已保留，请核对原因后重试",
        );
      }
      this.pending.delete(sessionId);
      await unlink(pending.path).catch(() => {});
      if (owner.signal.aborted)
        throw new FeedbackFailure(
          "GEA_FEEDBACK_IDENTITY_MISMATCH",
          "登录身份已变化，请使用当前身份重新提交反馈",
        );
      return {
        ok: true,
        value: {
          reportId: brandString<SessionFeedbackReportId>(result.reportId),
          receivedAt: result.receivedAt,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError")
        return {
          ok: false,
          error: { code: "GEA_FEEDBACK_TIMEOUT", message: "反馈上传超时，原包已保留，请重试" },
        };
      if (error instanceof FeedbackFailure)
        return { ok: false, error: { code: error.code, message: error.message } };
      const code =
        error instanceof Error && /^[A-Z_]{1,100}$/.test(error.message)
          ? error.message
          : "GEA_FEEDBACK_SUBMIT_FAILED";
      return {
        ok: false,
        error: {
          code,
          message:
            code === "GEA_FEEDBACK_IDENTITY_MISMATCH"
              ? "登录身份已变化，请按当前登录账号重新提交"
              : "反馈未成功；请确认登录和网络后重试，已冻结的内容会保持不变",
        },
      };
    }
  }
}

export function mountFeedbackSubmit(
  ctx: Context,
  business: Business,
  timeoutMs: number,
  maxZipBytes: number,
): void {
  const submitter = new FeedbackSubmitter(ctx, business, timeoutMs, maxZipBytes);
  ctx.effect(() => ctx.sessionFeedback.registerSubmit((request) => submitter.submit(request)));
}
