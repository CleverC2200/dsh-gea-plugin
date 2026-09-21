/**
 * 页面桥（page bridge）：让"右侧对话"读写"中间页面"的那条通道。
 *
 * 通用部分（本目录）：AG-UI 前端工具链路的协议形状、宿主侧队列、浏览器侧轮询运行时。
 * 业务部分（消费方）：工具名与参数白名单、页面快照格式、命令怎么落到页面上。
 *
 * 当前形态是"仓库内共用模块"：先让 GEA 当第一个消费者，接口稳定后再决定
 * 抽成独立插件（新仓库+渠道）还是并进 `@cleverc2200/dsh-agent-workbench`。
 * 所以这里刻意不出现任何业务词，也不依赖 cordis：换宿主只改消费方的两处接线。
 */
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
} from "./protocol.ts";
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
export {
  startPageBridgeClient,
  type PageBridgeApply,
  type PageBridgeApplyResult,
  type PageBridgeClientOptions,
} from "./client.ts";

/** 契约版本：接口不兼容时 +1，消费方据此判断要不要更新。 */
export const PAGE_BRIDGE_VERSION = 1;

/** 当前实现支持的协议能力，供消费方与将来的独立插件做兼容判断。 */
export const PAGE_BRIDGE_CAPABILITIES = [
  "ag-ui-frontend-tool",
  "tool-result-error",
] as const;
