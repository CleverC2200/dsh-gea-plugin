# 当前能力声明与受控执行

能力形状定义在 [contract](../src/capability/contract.ts)，装载由 [readPluginContract](../src/capability/declarations.ts) 校验，[registry](../src/capability/registry.ts) 管本 Host 安装能力。页面、Skill 和能力声明不授予服务端业务权限。

## HTML 声明输入

当前 [HTML 装载入口](../src/html-plugins.ts) 要求安装包明确提供 page/capability 分离声明，以及 Manage 的 Agent 资源贡献。`plugin.json` 声明如下引用，文件必须位于该安装目录内：

```json
{ "declarations": { "page": "page.json", "capability": "capability.json" } }
```

| 事实 | 当前来源与条件 |
|---|---|
| 模块、页面与 Consumer | plugin.json 的实际安装元数据，pageIds 与页面声明完全一致 |
| 页面 surface/protocol | page.json 明确声明，当前协议为 self-report |
| 数据 tables/rules | capability.json 提供，不扫描 HTML SQL、DOM 或 Skill 正文 |
| 能力 enabled | capability.json，缺省 true，非布尔值拒绝 |
| maxEffect/layers | 明确能力声明，不能超过安装模块允许的影响等级和层 |
| Agent prompt/Skill | Manage 从安装资源管理，不由页面或 GEA Client 建另一目录权威 |

HTML 的 `gea-html-v2` 当前只接收只读模块，不能通过声明升级成 draft、submit 或 approve。MCP 的 provider/transport/contract 与 AGENT Consumer 必须匹配；真实模块的 MCP 声明为 governed-sql-read，mock 模块的能力列表为空。`contractFromPlugin` 只提供已校验安装元数据的基础形状，缺声明不会沿旧路径自动派生。

缺文件、路径越界、缺页面引用、Consumer/协议不匹配、非法等级、重复模块/surface/page ID 都拒绝。诊断保留来源路径，重复项说明双方来源；解析失败不回退旧协议。资源与页面生命周期、取消和 owner 释放仍沿 Workbench/Manage 的公开入口，GEA 只提供业务 grant 和执行条件。

## 可见、启用与身份

Workbench 读取 `page.json.visible`，只控制目录和菜单。隐藏页面保留安装、声明与原 Session 归属，不等于停用能力。

`capability.json.enabled=false` 仍保留静态页面，将禁用状态传给 Manage，并拒绝资源选择、受管读取、页面动作和引用捕获。重新启用沿原 owner，不新增登录状态、Session 格式或第二配置平台。

原生销售沿 `workbenchCapability.enabled` 提供同一启用事实，缺省启用；`analysisAgentCode` 映射到实际原生合同，不是 SQL/MCP 例外。空注册表和未登记 Consumer 拒绝，不恢复历史名单。

真实入口在认证、委托或传输前检查合同。禁用返回 `GEA_CAPABILITY_DISABLED`，mock 合同返回 `GEA_CAPABILITY_MOCK_ONLY`，未登记 Consumer 返回 `GEA_PLUGIN_CONSUMER_NOT_ALLOWED`，影响等级或层不符返回 `GEA_CAPABILITY_EFFECT_NOT_ALLOWED`。这些结果不能代替服务端业务授权。

Manage 的当前安装与启用状态在模型步骤和工具派发前重新核对；GEA direct provider 也受当前资源保护。身份切换使旧请求失效。mock 页面可沿原 view/context/reference 行为运行，禁止真实 SQL、MCP、模型和业务写；模拟来源不伪装成真实授权。

## 验证与历史

能力合同、声明、取消、mock/disabled 执行的现有测试分别位于 `tests/capability-contract.test.mjs`、`tests/split-declarations.test.mjs`、`tests/mock-validation-execution.test.mjs` 和 `tests/disabled-model-resource.test.mjs`。按每次有效输入与 evidence 记录结果；本地合同不证明 Native 或真实服务验收。

[原能力文档](history/capability-contract-pre-agent-environment-04.md) 按清理前基线保留原字节，其中自动派生、DOM 扫描、旧 adapter 与兼容接入的描述是历史，不作为当前支持行为。公共类型、业务 Prompt/Skill、runtime 字符串和执行规则未由本次文档/注释清理修改。
