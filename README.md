# GEA 销售计划只读插件

独立安装的 DeepSeek Harness Web 插件，使用官方 `dsh` profile、认证 Fetch、现有 LLM provider 和标准 Session。业务代码全部位于本工程；不修改 dsh 源码或安装依赖，不执行业务审批、保存或写回。

## 安装与启动

使用 Node 24，在本目录执行：

```sh
npm ci
npm run build
cp gea.config.example.json gea.config.json
# 在 gea.config.json 中填写环境地址；凭证不写入该文件。
npm start -- --config gea.config.json --runtime .runtime/development --port 3198
```

使用启动进程本地日志中的带认证参数链接进入页面。点击「GEA 销售计划」后独立扫码登录、查询、选择版本和 SKU、预览输入范围，最后确认提交。会话使用 dsh 的标准取消、追问和历史读取功能。

`gea.config.example.json` 使用明确的本地回执模式，只验证数据传递。真实模型可使用直接 HTTPS 配置，也可按 [AionUi 接入说明](docs/aionui-model.md) 使用 `gea.aionui.example.json` 从已运行的 AionUi 读取所选模型和本机代理凭证。AionUi 退出或代理失效会中断其模型路径；不会自动切换模型或退回本地回执。

GEA 地址、请求超时、分页上限、快照大小和模型预算来自部署配置。`--runtime` 控制独立 Harness home 和工作区；`--port 0` 为自动回归分配独立端口。移动目录不需要编辑插件源码或硬编码插件路径。配置缺失或无效时启动失败。

## 数据与会话

Host 生成查询和预览 ID，并缓存已获取的详情、版本和 SKU。浏览器只能提交选择标识，不能把自己提供的业务对象加入快照。新查询、重新登录或 401 会使旧快照失效。业务权限 403 保留脱敏原因，不被当成未登录或空结果。

计划详情标注为当前计划数据，历史版本和版本 SKU 分别记录身份、来源及获取时间。缺失字段、总数未知和部分结果均保留；仅发送明确选中的范围。业务标识和十进制数字保留原始 JSON 数值文本，数量和金额差额通过 Decimal 计算后连同依据写入快照。超出配置的输入字节上限时拒绝发送，不静默截断。

分析 preset 不注册 Shell、网络或业务写工具。模型可见输入通过标准 `user/message` 持久化；成功、失败及取消使用已有 Session 事件。取消后若已有部分文本，dsh 可以保留 `interrupted: true` 的助手消息，同时以 `turn/end.reason.kind=aborted` 结束，不能将该消息计为完整回答。

GEA token 仅保存在当前 Host 内存中；重启后需要重新登录。模型凭证独立配置，不进入业务快照、普通配置或 profile patch。本地 `.runtime/` 包含会话、启动认证链接及验证证据，不应发布。

## 当前验证状态

兼容基线为固定 npm 发布版 `@deepseek-ai/dsh@0.1.5-rc.1`。本地检查使用真实官方 Web profile，仅替换外部 GEA/LLM HTTP 响应；包括查询隔离、精确数值、详情/历史版本/SKU 子集、登录过期/401/403、模型路由、取消与显式重试、一次提交、Session 磁盘读回和新进程恢复。浏览器回归操作实际页面并打开标准会话。

真实服务证据分开记录：旧原型曾通过测试 GEA 单记录到本地回执的验证；新版不能沿用该结果宣布验收完成。AionUi 真实模型最小标准 Session 调用已完成并持久化。新版完整计划、版本、SKU、真实模型分析以及真实业务会话新进程重开仍未验收；全部 Issue 保持开放。正式环境曾返回的业务 403 未被本项目修改。

尚待补齐：干净目录安装复现、扩展乱序/空结果/超限覆盖、完整无密钥录制回放、真实模型输入预算与长会话验证、完整真实业务验收、最终双轴审查。字节上限属于当前保守预检，不代表已经验证模型的完整上下文预算。

```sh
npm run typecheck
npm test
```

浏览器测试使用本机 Chrome，测试进程、端口和目录均由测试拥有。定向测试可运行 `node --test tests/<name>.test.mjs`。`scripts/verify.mjs` 和 `scripts/probe-gea.mjs` 属于旧原型诊断入口，尚未适配新版部署与选择 ID，不应用它们宣告新版真实验收。
