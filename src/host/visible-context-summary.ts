import type { Agent } from "@deepseek-ai/dsh-agent";

type TextBlock = { type: "text"; text: string };

type SubagentRun = {
  result: Promise<{ stopReason?: string; output?: unknown }>;
  dispose(): Promise<void>;
};

type SubagentRuntime = {
  start(
    provider: string,
    request: {
      label: string;
      prompt: TextBlock[];
      parent: Agent;
      signal: AbortSignal;
    },
  ): Promise<SubagentRun>;
};

type AgentWithSubagents = Agent & {
  ctx?: {
    get?: (name: string) => unknown;
    subagents?: SubagentRuntime;
  };
};

const MAX_SUMMARY_CHARS = 6000;
const MAX_FALLBACK_ROWS = 40;

function textFromOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (!Array.isArray(output)) return "";
  return output
    .filter(
      (block): block is TextBlock =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function compactLocally(snapshot: string): string {
  try {
    const parsed = JSON.parse(snapshot) as Record<string, unknown>;
    if (parsed.coverage !== "current-visible-page") return snapshot;
    const context = (parsed.context ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(context.visibleRows) ? context.visibleRows : [];
    const compact = {
      source: "GEA_RENDERED_WORKBENCH_SUMMARY",
      coverage: parsed.coverage,
      renderedAt: parsed.renderedAt,
      scope: context.scope,
      pagination: context.pagination,
      evidence: context.evidence,
      selectedPlanIds: context.selectedPlanIds,
      visibleRows: rows.slice(0, MAX_FALLBACK_ROWS),
      omittedRows: Math.max(0, rows.length - MAX_FALLBACK_ROWS),
      expandedFields: context.expandedFields,
      processor: "local-fallback",
    };
    return JSON.stringify(compact);
  } catch {
    return snapshot;
  }
}

function subagentPrompt(snapshot: string): string {
  return [
    "你是页面快照整理子 Agent。只处理下面给你的 JSON，不调用任何工具、不打开页面、不查询业务接口。",
    "请把快照压缩成给父 Agent 使用的只读证据摘要：保留页面范围、分页、读取时间、数据完整性，以及每个 visibleRows 的原始事实（尤其组织/客户、目标、计划、差额、状态、退回原因和 id；字段不存在就不要补）。",
    "可以压缩字段名、去掉重复外壳，但不能改数字、改名称、推算新结论或把缺失说成 0。最多输出 5000 个字符；最后列出 omittedRows。只输出摘要正文。",
    "页面快照：",
    snapshot,
  ].join("\n");
}

function getSubagentRuntime(agent: Agent): SubagentRuntime | undefined {
  // Cordis throws when an optional service is queried outside an injected
  // scope. Treat that exactly like an unavailable provider and keep the
  // snapshot path read-only and lossless.
  try {
    const context = (agent as AgentWithSubagents).ctx;
    const fromRegistry = context?.get?.("subagents");
    if (fromRegistry && typeof fromRegistry === "object")
      return fromRegistry as SubagentRuntime;
    return context?.subagents;
  } catch {
    return undefined;
  }
}

/**
 * Use DSH's one-shot child agent as the expensive snapshot-processing seam.
 * The parent receives only the child result; the raw browser snapshot never
 * enters the parent model context unless the child runtime is unavailable.
 */
export async function summarizeVisibleWorkbenchContext(
  snapshot: string,
  agent: Agent,
  signal: AbortSignal,
): Promise<string> {
  if (!snapshot.includes('"coverage":"current-visible-page"')) return snapshot;

  const runtime = getSubagentRuntime(agent);
  if (!runtime) return compactLocally(snapshot);

  let run: SubagentRun | undefined;
  try {
    run = await runtime.start("spawn", {
      label: "GEA 页面快照整理",
      prompt: [{ type: "text", text: subagentPrompt(snapshot) }],
      parent: agent,
      signal,
    });
    const result = await run.result;
    const summary = result.stopReason === "completed" ? textFromOutput(result.output) : "";
    if (summary) {
      return JSON.stringify({
        source: "GEA_RENDERED_WORKBENCH_SUMMARY",
        coverage: "current-visible-page",
        processor: "dsh-subagent",
        summary: summary.slice(0, MAX_SUMMARY_CHARS),
        rawSnapshotAvailable: true,
      });
    }
  } catch {
    // A child failure must not turn a valid page snapshot into a visible tool error.
  } finally {
    if (run) await run.dispose().catch(() => {});
  }
  return compactLocally(snapshot);
}
