# Agent 工作台

替换 DSH 的布局插件，为多个业务 Agent 提供独立页面和原生会话并排显示。运行基线是未修改的 npm `@deepseek-ai/dsh@0.1.5-rc.2`；不要求 DSH checkout，不复制聊天或输入框。

## 组合

通过 profile 补丁禁用 `ui-layout`，插入本包 Host entry，并配置绝对路径 `cwd`。DSH 的 `name` 补丁字段是名称检查，不能用来替换插件：必须采用“禁用旧行＋插入新行”。本包提供原有 `layout` 服务及 `sidebar`、`main`、`rightbar`、`shell.overlay` 插槽，保留原生导航、主题、设置、对话和右侧工具栏。工作台页面与原生会话并排时，原生右侧工具栏暂停显示。

## 业务插件接入

客户端声明注入 `slots`、`agentWorkbench`；先注册标准 `main` 页面，再注册工作台身份。页面卸载撤销并排显示，插件卸载撤销注册。

```ts
const unregister = ctx.agentWorkbench.register({ id: panelId, preset: 'my-agent' })
const hideConversation = ctx.agentWorkbench.showConversation(panelId)
await ctx.agentWorkbench.open(panelId, businessInstanceId)
// 已由业务 Host 创建会话时，可明确关联；不会修改该会话的预设：
await ctx.agentWorkbench.open(panelId, businessInstanceId, sessionId)
```

首次 `open` 按页面预设创建原生 Session；同一页面、同一业务实例复用 Session。`instance` 省略时恢复该页面上次实例，初始值为 `default`。创建并发合并，后发导航获胜；离开页面、注销或卸载不会停止后台 Agent。调用方处理 Promise 错误，不能把失败当成已切换。

会话关联保存在当前浏览器标签页的 `sessionStorage`，刷新可恢复，不支持跨设备恢复。只保存页面、业务实例与 Session 标识，不保存业务数据。登录身份失效时业务插件调用 `forget(panelId)` 并清除当前 Session。恢复前通过 DSH 刷新会话列表，缺失会话报错，不自动换成其他会话。`forget` 不删除 DSH 会话；后续 `open` 可创建新会话。

业务插件仍负责自身权限、页面内业务状态和需要发送给模型的上下文。界面展示本身不会向模型发送数据。原生输入框、草稿和消息全部由 DSH 管理。

## 维护

布局适配代码来自原有布局实现，来源见 UPSTREAM.md。升级 DSH 需要验证原生插槽、服务和客户端加载协议。此包与 GEA 无业务依赖；示例包使用同一接口验证第二个 Agent。当前源码在同一 npm workspace 内维护，尚未发布独立 npm 包。
