/** External GEA Fetch contribution and explicit local receipt provider. */
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionRequestId } from "@deepseek-ai/dsh-api-session-controller";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";
import {
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { Business, object, type Deployment } from "./business.ts";
import { GeaResponseError } from "./gea-error.js";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import type {} from "@deepseek-ai/dsh-client-connection";

export const inject = ["connection", "llm", "sessionController"];
export const Config = z.object({
  geaBaseUrl: z.string().required(),
  pageSize: z.natural().min(1).max(100).required(),
  periodPageSize: z.natural().min(1).max(1000).required(),
  requestTimeoutMs: z.natural().min(1000).max(120000).required(),
  maxSnapshotBytes: z.natural().min(1000).max(5000000).required(),
  runtimeDir: z.string().required(),
  analysisMode: z.union(["receipt", "model"]).required(),
  analysisModel: z.string().required(),
  inputByteBudget: z.natural().min(1).required(),
});

/** Runs the standard model call without making an external inference request. */
class ReceiptAdapter extends LlmAdapter {
  constructor(
    private readonly config: Deployment,
    private readonly runId: string,
  ) {
    super();
  }
  override providerInfo(id: string) {
    return { id, name: "GEA local receipt (no AI)" };
  }
  override async listModels(provider: string) {
    return [{ provider, id: "receipt", name: "Local receipt / 本地验证回执" }];
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    const request = JSON.stringify(options.messages);
    const snapshotHash = request.match(
      /GEA_SNAPSHOT_SHA256=([a-f0-9]{64})/,
    )?.[1];
    const text = `本地验证回执（非 AI 分析）：快照已进入 dsh 模型请求。\n\nSHA-256: ${snapshotHash ?? "not-present"}\n\n这是数据传递验证，不构成审批意见。`;
    await mkdir(this.config.runtimeDir, { recursive: true, mode: 0o700 });
    await appendFile(
      resolve(this.config.runtimeDir, "receipts.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        runId: this.runId,
        snapshotHash,
        requestHash: createHash("sha256").update(request).digest("hex"),
        provider: options.provider,
        model: options.model,
      }) + "\n",
      { mode: 0o600 },
    );
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

/** Register authenticated Web routes; the standard dsh connection owns browser authorization. */
export function apply(ctx: Context, config: Deployment): void {
  const business = new Business(config);
  ctx.effect(() => () => business.dispose());
  if (config.analysisMode === "receipt")
    ctx.effect(() =>
      ctx.llm.registerAdapter(
        ["gea-proof"],
        new ReceiptAdapter(config, business.runId),
      ),
    );
  let submission:
    | { id: string; result: Promise<{ sessionId: SessionId }> }
    | undefined;
  function submit(id: unknown) {
    const preview = business.prepared(id);
    if (submission?.id === preview.previewId) return submission.result;
    const result = (async () => {
      const session = await ctx.sessionController.create({
        cwd: resolve(config.runtimeDir, "workspace"),
        agentPreset: "gea-readonly",
      });
      business.prepared(preview.previewId);
      await ctx.sessionController.selectModel({
        sessionId: session.sessionId,
        provider:
          config.analysisMode === "model" ? "gea-analysis" : "gea-proof",
        model: config.analysisModel,
      });
      business.prepared(preview.previewId);
      await ctx.sessionController.prompt(
        {
          sessionId: session.sessionId,
          requestId: brandString<SessionRequestId>(randomUUID()),
          mode: "queue",
          content: [{ type: "text", text: preview.prompt }],
        },
        new AbortController().signal,
      );
      return session;
    })();
    submission = { id: preview.previewId, result };
    return result;
  }
  const endpoints = [
    "status",
    "login/start",
    "login/poll",
    "periods",
    "plans",
    "detail",
    "versions",
    "skus",
    "prepare",
    "submit",
  ];
  for (const endpoint of endpoints)
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path: "/api/gea-proof/" + endpoint,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request: Request) => {
          try {
            const payload = object(await request.json());
            let value: unknown;
            switch (endpoint) {
              case "status":
                value = business.status();
                break;
              case "login/start":
                value = await business.loginStart(request.signal);
                break;
              case "login/poll":
                value = await business.loginPoll(payload, request.signal);
                break;
              case "plans":
                value = await business.plans(payload, request.signal);
                break;
              case "periods":
                value = await business.periods(request.signal);
                break;
              case "detail":
                value = await business.detail(payload, request.signal);
                break;
              case "versions":
                value = await business.versions(payload, request.signal);
                break;
              case "skus":
                value = await business.skus(payload, request.signal);
                break;
              case "prepare":
                value = business.prepare(payload);
                break;
              case "submit":
                value = await submit(payload.previewId);
                break;
              default:
                throw new Error("UNKNOWN_ENDPOINT");
            }
            return Response.json(
              { ok: true, value },
              { headers: { "Cache-Control": "no-store" } },
            );
          } catch (error) {
            const code =
              error instanceof Error && /^[A-Z][A-Z_0-9]+$/.test(error.message)
                ? error.message
                : "GEA_REQUEST_FAILED";
            return Response.json(
              {
                ok: false,
                error:
                  error instanceof GeaResponseError
                    ? {
                        code: error.code,
                        message: error.message,
                        details: error.details,
                      }
                    : { code, message: code },
              },
              { headers: { "Cache-Control": "no-store" } },
            );
          }
        },
      }),
    );
}
