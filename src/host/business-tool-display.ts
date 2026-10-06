import type { ToolSchema } from "@deepseek-ai/dsh-llm";

const DECIMAL_DESCRIPTION = "精确十进制字符串；null 或省略表示缺失，不补零。不传 JSON 浮点数。";
const DISPLAY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  render_ui:
    "以 dsh-ui 同词汇的白名单组件树渲染工具行交互卡片；协议与组件先读当前原生 genui Skill。客户端 action 返回 [genui-action]，按交互重新渲染。内联 UI 用围栏；简单事实或明确纯文字可用文字。展示不授予业务权限。",
  validate_dsh_ui:
    "输出 dsh-ui 围栏前校验复杂 spec（≥3 节点或含表格）；≤2 简单节点可省略。传待输出的原始 JSON 字符串或对象。返回 genui-validation 的状态、诊断、next、reply_language；仅 next=emit_repaired_fence 时输出 repaired_json。warning=block_markdown 时按替代节点重新校验。",
};

/** Business-only model display; the native registered schema and validator remain authoritative. */
export function businessToolDisplay(tool: ToolSchema): ToolSchema {
  if (tool.name !== "forecast_compute" && !DISPLAY_DESCRIPTIONS[tool.name]) return tool;
  const parameters = structuredClone(tool.parameters);
  if (tool.name === "forecast_compute") {
    const shorten = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(shorten);
      } else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.description === DECIMAL_DESCRIPTION)
          record.description = "十进制字符串；null/省略为缺失，不补零，不传浮点。";
        Object.values(record).forEach(shorten);
      }
    };
    shorten(parameters);
  }
  if (tool.name === "render_ui") {
    const spec = (parameters.properties as Record<string, Record<string, unknown>>).spec;
    spec.description =
      "工具行卡片的白名单组件树，与 dsh-ui 围栏同协议；内联展示用围栏，独立卡片用此工具。简单事实或明确纯文字可用文字。必须传 JSON 对象，不传序列化字符串；渲染器深层校验并修复。组件参考先读原生 genui Skill。";
  }
  return {
    ...tool,
    description: DISPLAY_DESCRIPTIONS[tool.name] ?? tool.description,
    parameters,
  };
}
