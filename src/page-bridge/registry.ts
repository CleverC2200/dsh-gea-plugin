/**
 * 把"页面自述的能力目录"变成模型可见的工具。
 *
 * 通用层：这里不认识任何具体页面/业务。它只做三件事：
 * 1) 按页面声明，为该会话注册/注销**agent 作用域**的工具（页面关掉，工具就消失）；
 * 2) 用目录生成工具说明与参数表（不再手写枚举和说明）；
 * 3) 把调用转成"前端工具调用"下发，并把页面的回填结果作为工具结果返回。
 *
 * 依赖 DSH 的能力：`agent.ctx.tools.register`（按 agent 作用域注册，返回 disposer）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  compilePageCatalog,
  elementDirectory,
  pageActionEffect,
  resolvePageAction,
  validatePageCatalog,
  type PageActionParam,
  type PageActionScalar,
  type PageCatalog,
  type PageElementEffect,
} from "./catalog.ts";
import type { PageBridge } from "./host.ts";
import { createDraftLayer, type DraftLayer } from "../capability/draft.ts";

export type PageToolConsumer = {
  /** 业务侧语义校验/归一化：返回真正下发给页面的参数。 */
  validate?: (args: Record<string, unknown>, sessionId: string) => unknown;
  /** 业务侧的当前页面状态：桥用它判断"改动后的状态是否已经报回来"。 */
  stateSnapshot?: (
    sessionId: string,
  ) => { sequence: number; state: unknown } | undefined;
  /** 单次调用等页面执行的时长。 */
  waitMs?: number;
  /** 应用成功后再等页面报回新状态的时长。 */
  refreshWaitMs?: number;
  /** 页面多久没再声明就认为已关闭。 */
  staleMs?: number;
  /**
   * 允许被对话改动的页面白名单（页面自述的 surface）。
   * 提供了白名单时，不在名单里的页面一律不注册工具（fail-closed）。
   */
  allowSurfaces?: readonly string[];
  /**
   * 哪些页面允许暴露"会改数据"的动作（页面自述的 surface）。
 * 默认空：只暴露改视图的动作；页面自己声明了 data 动作也不给模型。
 * 只对白名单页面逐页放开，避免"任何页面都能被改数据"。
 */
  dataActionSurfaces?: readonly string[];
  /**
   * 工作台会话里要禁用的全局工具（例如浏览器/MCP 那批）。
   * 只作用于"页面声明过能力的那个 agent"，普通对话不受影响。
   */
  denyGlobalToolsInWorkbench?: readonly string[];
  /**
   * 这个页面允许被改到的最大影响等级（由能力契约决定）。
   * 契约只声明"改草稿"的页面，提交/审批类元素一律不下发。
   */
  allowsEffect?: (surface: string, effect: PageElementEffect) => boolean;
  /** "改草稿"这一层的实现（限流/超时/回执/确认）；不传就按默认参数建一个。 */
  draftLayer?: DraftLayer;
};

/**
 * 这一屏的目录从哪来：
 * - self-report：页面自己上报（新协议，最准）；
 * - dom-scan：宿主扫同源页面生成（迁移期回退，页面不用改）。
 */
export type PageCatalogSource = "self-report" | "dom-scan";

function parsePageContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** 目录里的标量参数 -> DSH schema 片段（只做机械映射）。 */
function scalarSchema(value: PageActionScalar) {
  const description =
    value.description === undefined ? {} : { description: value.description };
  switch (value.type) {
    case "string":
      return {
        type: "string" as const,
        ...description,
        ...(value.enum === undefined ? {} : { enum: [...value.enum] }),
      };
    case "integer":
      return { type: "integer" as const, ...description };
    case "number":
      return { type: "number" as const, ...description };
    case "boolean":
      return { type: "boolean" as const, ...description };
  }
}

/** 目录里的参数形状 -> DSH 工具参数 schema。 */
function parameterSchema(parameter: { name: string } & PageActionParam) {
  const shared = {
    ...(parameter.required ? { required: true as const } : {}),
    ...(parameter.description === undefined
      ? {}
      : { description: parameter.description }),
  };
  if (parameter.type === "array")
    return {
      type: "array" as const,
      ...shared,
      items: scalarSchema({
        type: parameter.items.type,
        ...(parameter.items.description === undefined
          ? {}
          : { description: parameter.items.description }),
      }),
    };
  if (parameter.type === "object")
    return {
      type: "object" as const,
      additionalProperties: false,
      ...shared,
      properties: Object.fromEntries(
        Object.entries(parameter.properties).map(([name, value]) => [
          name,
          scalarSchema(value),
        ]),
      ),
    };
  return { ...scalarSchema(parameter), ...shared };
}

/**
 * 建一个"页面工具注册表"。
 * 每个会话最多一个工具；目录变化时注销旧的、注册新的。
 */
export function createPageToolRegistry(
  ctx: Context,
  bridge: PageBridge,
  consumer: PageToolConsumer = {},
) {
  const waitMs = consumer.waitMs ?? 4000;
  const refreshWaitMs = consumer.refreshWaitMs ?? 2000;
  const drafts = consumer.draftLayer ?? createDraftLayer();
  const registered = new Map<
    string,
    {
      key: string;
      at: number;
      dispose: () => void;
      restraint?: () => void;
      /** 这一屏的目录是页面自己报的，还是宿主扫出来的。 */
      source: PageCatalogSource;
    }
  >();
  const restrictionFailed = new Set<string>();

  /**
   * 只在该 agent 作用域禁用指定全局工具。
   * 限制是"锦上添花"：任何失败都只记日志，绝不影响工作台工具本身注册。
   */
  const restrictWorkbenchTools = (
    agent: { ctx: { tools: { restrict: (f: { deny: string[] }) => () => void } } },
    candidates: readonly string[],
  ): (() => void) | undefined => {
    // 先探一次，从错误信息里拿到"当前实际存在的全局工具名"：
    // restrict 对未知名字是整体抛错，硬编名单会随部署增删工具而失效。
    let known: string[] = [];
    try {
      agent.ctx.tools.restrict({ deny: ["__page_bridge_probe__"] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      known = (/known global tools: (.*)$/.exec(message)?.[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    }
    const target = new Set<string>();
    for (const name of candidates) if (known.includes(name)) target.add(name);
    // 兜底：所有浏览器 MCP 工具（按前缀，未来新增的也覆盖）。
    for (const name of known)
      if (/^mcp__browser/i.test(name)) target.add(name);
    if (target.size === 0) return undefined;
    try {
      return agent.ctx.tools.restrict({ deny: [...target] });
    } catch (error) {
      console.log(
        `[page-bridge] restrict failed: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 200),
      );
      return undefined;
    }
  };
  /** 同一个会话的"没有活跃 agent"只提示一次，避免刷日志。 */
  const skipped = new Set<string>();
  // 页面关闭后不再声明，工具应当在合理时间内消失，而不是一直挂着。
  const staleMs = consumer.staleMs ?? 30_000;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, entry] of [...registered])
      if (now - entry.at > staleMs) {
        registered.delete(sessionId);
        entry.dispose();
      }
  }, Math.min(staleMs, 10_000));
  sweep.unref?.();

  const invoke = async (
    sessionId: string,
    catalog: PageCatalog,
    args: Record<string, unknown>,
    options: { dataAllowed: boolean; source: PageCatalogSource },
  ): Promise<string> => {
    const kind = typeof args.kind === "string" ? args.kind : null;
    // 只要目录、不做事：目录本身不再写进工具说明（那会让每次请求都付一次 token）。
    // 线上实测模型会把"要目录"写成 kind=directory（不在动词枚举里），两种写法都认。
    if (args.directory === true || kind === "directory")
      return JSON.stringify({
        source: "PAGE_BRIDGE",
        protocol: "ag-ui-frontend-tool",
        authority: "view-only",
        tool: { toolCallName: catalog.tool, toolCallId: null },
        directory: elementDirectory(catalog, {
          ...(typeof args.focus === "string" ? { focus: args.focus } : {}),
          ...(args.values === true ? { values: true } : {}),
        }),
        note: "这是只读目录：没有下发任何操作，也不会改动这一屏。",
      });
    /** 拒绝一次调用：命令没有下发，模型据此知道"这条路走不通"而不是页面没反应。 */
    const refuse = (error: string, note: string) =>
      JSON.stringify({
        source: "PAGE_BRIDGE",
        protocol: "ag-ui-frontend-tool",
        authority: "view-only",
        tool: { toolCallName: catalog.tool, toolCallId: null },
        kind,
        applied: false,
        error,
        note,
      });
    // 没给动词也没要目录：说清楚要传什么，而不是抛一个看不懂的元素错误。
    if (kind === null)
      return refuse(
        "PAGE_KIND_REQUIRED",
        "要改这一屏请传 kind=invoke/setValue/select/clear（并给 target/action/value）；只要元素目录就传 directory=true。",
      );
    // 只读元素不能被改、后台元素不存在：宿主按页面声明先挡一道。
    const violation = resolvePageAction(catalog, args);
    if (violation) return refuse(violation, "页面没有开放这个元素/动作，命令没有下发。");
    if (kind === "setValue" && !options.dataAllowed)
      return refuse("DATA_ACTION_NOT_ALLOWED", "这个页面只允许改视图，不允许写字段。");
    // 影响等级由契约卡住：只声明"改草稿"的页面，提交/审批类元素不下载到页面。
    const effect = pageActionEffect(catalog, args);
    const allowsEffect = consumer.allowsEffect ?? (() => effect === "draft");
    if (!allowsEffect(catalog.surface, effect))
      return refuse(
        "EFFECT_NOT_ALLOWED",
        effect === "approve"
          ? "这个页面没有开放审批动作，命令没有下发。"
          : "这个页面没有开放提交动作，命令没有下发。",
      );
    // "改草稿"这一层统一管限流、回执与超时：页面只声明能力，不写执行逻辑。
    const begun = drafts.begin({
      sessionId,
      surface: catalog.surface,
      kind: kind ?? "",
      targets: [
        ...(typeof args.target === "string" ? [args.target] : []),
        ...(Array.isArray(args.targets)
          ? (args.targets as unknown[]).filter(
              (value): value is string => typeof value === "string",
            )
          : []),
      ],
      effect,
      ...(typeof args[catalog.reasonField ?? "reason"] === "string"
        ? { reason: String(args[catalog.reasonField ?? "reason"]) }
        : {}),
    });
    if (!begun.ok) return refuse(begun.code, begun.reason);
    // 元素目录由桥自己按声明校验；旧的动作目录仍交给业务校验器。
    const validated =
      consumer.validate && catalog.elements === undefined
      ? consumer.validate(args, sessionId)
      : args;
    const before = consumer.stateSnapshot?.(sessionId)?.sequence ?? 0;
    const toolCallId = bridge.enqueue(sessionId, {
      toolCallName: catalog.tool,
      args: validated,
    });
    const message = await bridge.wait(sessionId, toolCallId, waitMs);
    if (message === undefined) bridge.cancel(sessionId, toolCallId);
    let pageApplied = message !== undefined && message.error === undefined;
    if (pageApplied && message) {
      try {
        const content = JSON.parse(message.content);
        if (content && typeof content === "object" && content.applied === false)
          pageApplied = false;
      } catch {
        // Legacy pages may return plain text; absence of an applied flag keeps
        // the existing success semantics while explicit false is authoritative.
      }
    }
    const applied = pageApplied;
    const pageError =
      message === undefined
        ? "PAGE_TOOL_PENDING"
        : message.error ?? (pageApplied ? undefined : "PAGE_TOOL_NOT_APPLIED");
    drafts.finish(begun.receiptId, {
      applied,
      ...(message === undefined
        ? { error: "PAGE_TOOL_PENDING", timedOut: true }
        : pageError === undefined
          ? {}
          : { error: pageError }),
    });
    const receipt = drafts.receipts().find((entry) => entry.id === begun.receiptId);
    let snapshot = consumer.stateSnapshot?.(sessionId);
    if (applied && consumer.stateSnapshot) {
      const deadline = Date.now() + refreshWaitMs;
      while ((snapshot?.sequence ?? 0) <= before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        snapshot = consumer.stateSnapshot(sessionId);
      }
    }
    const snapshotAfterApply = (snapshot?.sequence ?? 0) > before;
    return JSON.stringify({
      source: "PAGE_BRIDGE",
      protocol: "ag-ui-frontend-tool",
      authority: "view-only",
      tool: { toolCallName: catalog.tool, toolCallId },
      kind,
      applied,
      pageSource: options.source,
      draft: receipt === undefined
        ? null
        : {
            id: receipt.id,
            outcome: receipt.outcome,
            ...(receipt.error === undefined ? {} : { error: receipt.error }),
          },
      snapshotAfterApply,
      ...(message === undefined
        ? {
            availability: "pending",
            code: "PAGE_TOOL_PENDING",
            reason:
              "页面还没执行这次改动（可能刚切走工作台或页面正在加载）。现在不能说页面已经改好了。",
          }
        : {}),
      ...(pageError ? { error: pageError } : {}),
      ...(applied && !snapshotAfterApply
        ? {
            availability: "refreshing",
            code: "PAGE_STATE_REFRESHING",
            reason:
              "页面已经应用了这次改动，但还没报回改动后的状态；下面附的是改动前的状态，不要用它判断改动结果。",
          }
        : {}),
      page: message === undefined ? null : parsePageContent(message.content),
      state: snapshot?.state ?? null,
      note: "只改了当前页面的显示范围，没有读取或改动任何业务数据，也不代表审批意见。",
    });
  };

  const dispose = (sessionId: string): void => {
    const existing = registered.get(sessionId);
    if (!existing) return;
    registered.delete(sessionId);
    existing.dispose();
    existing.restraint?.();
  };

  return {
    /**
     * 应用一次页面声明。
     * - 不带声明（undefined）：保持现状（轮询不必每次都重复声明）；
     * - 显式声明为 null：页面已经没有可调用动作，注销该会话的工具。
     */
    declare(
      sessionId: string,
      rawCatalog: unknown,
      source: PageCatalogSource = "self-report",
    ): void {
      if (rawCatalog === undefined) return;
      if (rawCatalog === null) {
        dispose(sessionId);
        return;
      }
      const catalog = validatePageCatalog(rawCatalog);
      // 只允许改白名单里的页面；不在名单里就当作没有能力。
      if (
        consumer.allowSurfaces &&
        !consumer.allowSurfaces.includes(catalog.surface)
      ) {
        dispose(sessionId);
        return;
      }
      // 默认只暴露"改这一屏怎么看"的动作；改业务数据的动作必须显式放开。
      const dataAllowed =
        consumer.dataActionSurfaces?.includes(catalog.surface) === true;
      const actions = (catalog.actions ?? []).filter(
        (action) => action.scope !== "data" || dataAllowed,
      );
      // 元素目录的页面没有自定义动作；只要它声明了元素就继续注册。
      if (actions.length === 0 && (catalog.elements?.length ?? 0) === 0) {
        dispose(sessionId);
        return;
      }
      const effective: PageCatalog = {
        ...catalog,
        ...(actions.length === 0 ? {} : { actions }),
      };
      const key = JSON.stringify(effective);
      const existing = registered.get(sessionId);
      if (existing?.key === key) {
        existing.at = Date.now();
        return;
      }
      const agent = ctx.agents.get(sessionId as SessionId);
      // 没有活跃会话就先不注册；页面下一轮轮询会再声明。
      if (!agent) {
        if (!skipped.has(sessionId)) {
          skipped.add(sessionId);
          console.log(
            `[page-bridge] declare skipped (no live agent) session=${sessionId}`,
          );
        }
        return;
      }
      dispose(sessionId);
      const { description, parameters } = compilePageCatalog(effective);
      const disposeTool = agent.ctx.tools.register(
        defineTool({
          name: effective.tool,
          description,
          parameters: Object.fromEntries(
            parameters.map((parameter) => [
              parameter.name,
              parameterSchema(parameter),
            ]),
          ),
          output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
            presentationMeta: () => ({
              source: "PAGE_BRIDGE",
              authority: "view-only",
            }),
          },
          timeoutMs: waitMs + 4000,
          isConcurrencySafe: () => false,
          presentCall: (args) => ({
            card: "generic",
            title: `${effective.tool} · ${String(args.kind ?? "")}`,
            rawInput: args,
          }),
          execute: async (args, exec) =>
            invoke(exec.agent?.id ?? sessionId, effective, args, {
              dataAllowed,
              source,
            }),
        }),
      );
      const restraint = consumer.denyGlobalToolsInWorkbench
        ? restrictWorkbenchTools(
            agent as never,
            consumer.denyGlobalToolsInWorkbench,
          )
        : undefined;
      if (consumer.denyGlobalToolsInWorkbench && !restraint && !restrictionFailed.has(sessionId)) {
        restrictionFailed.add(sessionId);
        console.log(
          `[page-bridge] workbench tool restriction not applied session=${sessionId}`,
        );
      }
      registered.set(sessionId, {
        key,
        at: Date.now(),
        dispose: disposeTool,
        source,
        ...(restraint === undefined ? {} : { restraint }),
      });
      skipped.delete(sessionId);
      console.log(
        `[page-bridge] registered tool=${effective.tool} session=${sessionId} source=${source} elements=${effective.elements?.length ?? 0} actions=${effective.actions?.length ?? 0} descLen=${description.length}`,
      );
    },
    /** 会话结束或身份变化时清掉。 */
    dispose(sessionId: string): void {
      dispose(sessionId);
    },
    disposeAll(): void {
      for (const sessionId of [...registered.keys()]) dispose(sessionId);
    },
    /** 最近的"改草稿"回执，供诊断与验收复核。 */
    receipts: () => drafts.receipts(),
  };
}

export type PageToolRegistry = ReturnType<typeof createPageToolRegistry>;
