# Agent Note: 预测业务 Surface 与 dsh 对话归属分离

Status: implemented

## 背景

AionUi 参考页面由业务导航栏、独立销售计划工作台和 dsh 对话栏组成。插件此前把这些职责放在一个 `client.tsx` 组件中，并在右栏绘制插件自己的输入框。

## 决策

`src/forecast-surface.tsx` 现在负责业务 Surface 的接口和组件：`BusinessNavigation`、`BusinessMessageInbox`、`SalesPlanWorkbench`、`ForecastConversationRail` 和 `ForecastAssistantSurface`。查询、登录、预览和 Session 仍由 `client.tsx` 持有。右栏接收宿主提供的可选 `nativeConversation` 节点，并报告原生槽位是否等待或已挂载；缺少宿主能力时只显示状态信息，不仿造 dsh ChatView。

## 放弃的方案

插件不再创建第二套聊天实现，不通过本地 textarea 冒充消息通道，也不声称 dsh 原生对话栏已经挂载。消息待办入口在 GEA 数据协议和宿主路由可用前保持禁用。

## 验证

Web 回归检查预测助手 rail 标记和 `native-host-pending` 状态。`npm run typecheck`、`npm run build`、`npm test` 和 `git diff --check` 均通过。

## 限制

宿主仍需提供官方 ChatSurface 注入点，才能挂载原生右侧对话栏。当前代码是适配接缝，不代表原生聊天已经集成。
