/** Shared page action runtime. Business hosts supply their own page adapters and policies. */
export {
  AGUI_EVENT_TOOL_CALL_ARGS,
  AGUI_EVENT_TOOL_CALL_END,
  AGUI_EVENT_TOOL_CALL_START,
  PAGE_BRIDGE_LIMITS,
  validateToolMessages,
  type AgUiEvent,
  type AgUiToolCallArgsEvent,
  type AgUiToolCallEndEvent,
  type AgUiToolCallStartEvent,
  type AgUiToolMessage,
} from "@cleverc2200/dsh-agent-workbench/page-interaction/protocol";
export { createPageBridge, type PageBridge, type PageBridgeOptions } from "./host.ts";
export {
  compilePageCatalog,
  validatePageCatalog,
  PAGE_CATALOG_LIMITS,
  type PageAction,
  type PageActionParam,
  type PageCatalog,
} from "./catalog.ts";
export {
  createPageToolRegistry,
  type PageToolConsumer,
  type PageToolRegistry,
} from "./registry.ts";
/** 契约版本：接口不兼容时 +1，消费方据此判断要不要更新。 */
export const PAGE_BRIDGE_VERSION = 1;

/** 当前实现支持的协议能力，供消费方与将来的独立插件做兼容判断。 */
export const PAGE_BRIDGE_CAPABILITIES = [
  "ag-ui-frontend-tool",
  "tool-result-error",
] as const;
