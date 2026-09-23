/**
 * 业务会话里禁用的"全局工具"（浏览器自动化 + 终端/侧栏）。
 *
 * 为什么要做：模型请求里的**工具清单是每次请求都占上下文的固定开销**。实测挂上浏览器 MCP
 * 的会话有 25 个 `mcp__browser__*` 工具，合计 18,498 字符（占工具块 66.7%，把整块从
 * 12.2k 推到 27.7k）；`dsh-better-sidebar` 在用户开了侧栏/终端卡片时还会再注册
 * `sidebar_open` + 8 个 `terminal_*`。这些跟业务问答无关，却每次都要占上下文。
 *
 * 做法：DSH 的 `agent.ctx.tools.restrict({deny})` 是**可见性**过滤——被 deny 的工具既不会被
 * 模型看到（不进工具清单，真正省上下文），也不会被调用。名字分两类：
 * - 前缀（`mcp__browser`、`terminal_`）：部署增删工具也覆盖得到；
 * - 精确名（`sidebar_open`）。
 * `restrict` 对未知名字会整体抛错，所以先探一次"当前实际存在的全局工具名"，只 deny 交集；
 * 任何失败只记日志，绝不影响其它工具。
 *
 * 标准编码类预设（auto-negotiation / standard）保留终端工具，避免误伤在同一运行时里
 * 干活的编码会话；浏览器工具在所有会话里都禁（业务运行时不靠它取数）。
 */

export const BROWSER_TOOL_PREFIX = "mcp__browser";
export const TERMINAL_TOOL_PREFIX = "terminal_";
export const SIDEBAR_TOOL_NAME = "sidebar_open";
/** 这些预设是"编码/通用"预设，保留终端类工具。 */
export const CODING_PRESETS = ["auto-negotiation", "standard"];

type RestrictableAgent = {
  session?: {
    header?: { agentPreset?: unknown; meta?: { agentPreset?: unknown } };
  };
  ctx: {
    tools: {
      /** 探名字（对未知名字整体抛错，错误里带已知清单）。 */
      restrict: (filter: { deny: string[] }) => () => void;
    };
  };
};

/** 从 agent 上取当前预设名（拿不到返回 undefined）。 */
export function presetOf(agent: unknown): string | undefined {
  const session = (agent as RestrictableAgent | undefined)?.session;
  const value = session?.header?.agentPreset ?? session?.header?.meta?.agentPreset;
  return typeof value === "string" ? value : undefined;
}

/** 这次要 deny 的名字（按已知清单过滤后）。导出来给测试用。 */
export function denyTargetsFor(
  known: readonly string[],
  preset: string | undefined,
): string[] {
  const coding = preset !== undefined && CODING_PRESETS.includes(preset);
  const target = new Set<string>();
  for (const name of known) {
    if (name.startsWith(BROWSER_TOOL_PREFIX)) target.add(name);
    else if (!coding && (name.startsWith(TERMINAL_TOOL_PREFIX) || name === SIDEBAR_TOOL_NAME))
      target.add(name);
  }
  return [...target];
}

/**
 * 给这个 agent 装上工具可见性限制；返回 disposer（失败返回 undefined，只记日志）。
 * 幂等：同一 agent 重复调用只会加一层同名限制。
 */
export function restrictToolsForAgent(
  agent: RestrictableAgent,
  log: (message: string) => void = () => {},
): (() => void) | undefined {
  let known: string[] = [];
  try {
    agent.ctx.tools.restrict({ deny: ["__session_restraint_probe__"] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    known = (/known global tools: (.*)$/.exec(message)?.[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  }
  const deny = denyTargetsFor(known, presetOf(agent));
  if (deny.length === 0) return undefined;
  try {
    return agent.ctx.tools.restrict({ deny });
  } catch (error) {
    log(
      `[session-tools] restrict failed: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 200),
    );
    return undefined;
  }
}

/**
 * 挂在 `agent/pre-step` 上，每个 agent 只装一次。
 *
 * 必须在**第一步之前**装好，否则模型第一份工具清单已经带着那些工具发出去了。
 */
export function mountSessionToolRestraint(
  ctx: import("@deepseek-ai/cordis").Context,
  log: (message: string) => void = () => {},
): () => void {
  const seen = new Set<unknown>();
  const disposers: Array<() => void> = [];
  // 和 turn-anchor 同一个钩子形态：around 式，必须把 next() 的结果传下去。
  const off = ctx.on("agent/pre-step", async ({ agent }, next) => {
    if (agent && !seen.has(agent)) {
      seen.add(agent);
      const dispose = restrictToolsForAgent(agent as RestrictableAgent, log);
      if (dispose) disposers.push(dispose);
    }
    return next();
  });
  return () => {
    off();
    for (const dispose of disposers.splice(0)) dispose();
    seen.clear();
  };
}
