# GEA 外部插件验证

本项目验证：不修改 DeepSeek Harness 源码，能否独立安装 GEA 页面和服务端插件，并把选中的销售计划记录送入持久化会话。这是可丢弃的集成原型，不是完整业务迁移。

## 当前结论

2026-09-10，官方 npm 发布版 `@deepseek-ai/dsh@0.1.5-rc.1` 已成功加载本插件。浏览器侧边栏与销售计划页面、受认证保护的服务端接口、选中演示记录到会话、模型请求回执、会话落盘及服务重启后恢复均已实际验证。

真实业务验收被 GEA 授权拒绝阻塞。2026-09-10 17:48（中国时间），扫码登录与身份接口均成功，确认租户为 `0`；销售周期 `/sales-plan/periods` 与计划列表 `/sales-plan/plans` 都返回 HTTP 403、`errorCode=SALES_PLAN_FORBIDDEN`、`category=AUTHORIZATION`，提示“当前用户无权操作该销售计划”。令牌和租户请求头与 AionCore 实现一致，补齐请求关联 ID 后仍被拒绝。需要 GEA 端核查该账号的销售计划授权与组织范围；现有响应没有指出具体缺少哪项授权。更早的登录接口 502 已恢复，原因未确定。现有演示会话标注 `LOCAL_FIXTURE_NOT_REAL_BUSINESS`，不得描述为真实 GEA 验收。

本次测试的是 npm 发布产物，不是从当前 dsh checkout 重新构建的产物。原仓库 `/Users/synear/Documents/ChatGPT/dpherness` 的 HEAD 保持 `2377c272a8e839e0a84c9f0e623b867a1dce2014`，工作区保持干净，origin 仍指向个人 fork。本项目未修改或补丁覆盖任何 dsh 源码、node_modules 文件。

## 组成

| 文件 | 用途 |
| --- | --- |
| `src/host.js` | GEA 登录、固定只读查询、选中记录快照；本地 LLM 回执适配器 |
| `src/client.jsx` | dsh sidebar/main 插槽注册、独立页面、标准 Session 创建和 prompt 调用 |
| `gea.patch.yml` | profile 覆盖层：注册外部插件，选择本地回执模型，配置 GEA 地址 |
| `scripts/start.mjs` | 通过官方 dsh CLI/profile 启动，使用独立 DSH_HOME |
| `scripts/verify.mjs` | HTTP 黑盒校验、持久化日志与快照 SHA-256 核对 |
| `scripts/probe-gea.mjs` | 复现真实 GEA 查询，并对照身份和销售周期只读接口 |

主流程是：GEA 页面 → dsh 认证 Fetch 接口 → 外部 Host 插件 → GEA GET 查询 → 带来源、查询时间、覆盖范围的选中记录 → 标准 Session prompt → dsh 日志和本地模型回执。

GEA access token 只存在服务端内存中，不返回浏览器，不写入会话。Host 只实现固定的扫码登录和销售计划列表调用；浏览器不传任意上游地址、凭证或 HTTP 方法。长整数标识和数量金额保留原始 JSON 数值文本。真实接口的字段兼容性仍待登录后验证。

## 复现

使用 Node 24。在本目录运行：

```sh
npm ci
npm run build
npm start
```

通过 `.runtime/server.log` 中本次启动生成的 dsh 本地链接打开页面，服务监听 `127.0.0.1:3199`。该日志仅供本机使用。点击侧边栏“GEA 销售计划”，载入演示数据，再点击“发送选中记录到会话”。会话选择 `gea-proof/receipt`，回执明确说明它不是 AI 分析。

随后在本目录另一终端运行 `npm run verify`。程序通过正常启动令牌交换建立自己的 HTTP 会话，不读取浏览器 Cookie。结果写入 `.runtime/verification.json`。它校验未认证请求 401、外站 Origin 403、GEA 未登录拒绝、无效选中记录拒绝、持久化用户快照摘要、助手回执与实际适配器请求摘要一致。

真实验收使用 `npm run verify -- --require-live`。除了上述检查，还要求存在来源为 `GEA_LIVE_READONLY` 的会话，并与 Host 查询后生成的交接记录对应。仅有演示数据时，这条命令会明确失败；报告中的 `liveBusinessVerified` 保持 `false`。已实际验证该失败路径，防止将演示结果算作真实验收。

403 等失败使用 `node scripts/probe-gea.mjs` 复现；添加 `--wait-login` 最多等待 110 秒供用户扫码。脱敏的错误原因、错误码和关联 ID 写入 `.runtime/gea-probe.json` 与 `.runtime/upstream-errors.jsonl`，不返回整个上游响应，不导出令牌。真实查询开始时清除上一次列表和待发送快照，避免失败后误发送旧的演示数据。`node --test scripts/gea-error.test.mjs` 覆盖原因保留、令牌脱敏和非 JSON 拒绝响应。

在启动终端按 Ctrl-C 停止，然后重新运行 `npm start`，刷新浏览器。已验证演示会话在重启后恢复。运行状态和会话位于 `.runtime/`；GEA 登录状态不会跨重启保留。

更换环境时修改 `gea.patch.yml` 的 `geaBaseUrl` 并重启。插件路径目前固定到本机目录；移动项目需同时修改该文件的 `name`。

## 验证证据

- 浏览器真实点击完成：全局面板 → 演示数据 → 选中记录 → 创建会话 → 展示回执。
- 演示会话：`session-667e536a-3150-4209-9ca0-c726a839c3b0`。
- 快照 SHA-256：`134792d0efbd475f0b18dd16a2c0ca2a1ccd13817c1ccbe0e9b8546c6ff3b694`。
- 持久化文件：`.runtime/home/sessions/--Users-synear-Documents-ChatGPT-gea-dsh-plugin-prototype-.runtime-workspace---/session-667e536a-3150-4209-9ca0-c726a839c3b0/session.v3.jsonl.zstd`。
- 重启前后均执行黑盒校验通过；浏览器重载后显示相同用户数据和回执。
- 2026-09-10 17:48 浏览器实测：载入演示记录后查询真实计划，页面显示 GEA 返回的具体授权错误，旧演示列表和发送按钮均被移除；登录状态仍有效。
- `.runtime/handoffs.jsonl` 记录交接摘要；`.runtime/receipts.jsonl` 记录本地适配器实际收到的请求摘要。标题生成也会调用适配器，所以回执记录数不等于业务会话数。

本次拒绝的查询记录见 `.runtime/gea-probe.json`。销售周期 requestId 为 `094cb4fa-ccaa-4afa-adbf-794fb2dad034`；销售计划 requestId 为 `9f8e352c-b9af-4ae4-a079-84d904ceac48`，可供 GEA 服务端关联日志。没有修改权限、切换身份、变更租户或尝试绕过拒绝。

## 后续仍需验证

1. GEA 环境与飞书扫码登录已通过。待 GEA 端确认当前账号在租户 `0` 的销售计划授权后，查询真实列表，再走相同会话交接校验。
2. AionCore 适配器：当前运行中的 AionCore 需要独立登录，本原型直接复用 GEA 登录协议，没有证明 AionCore 身份桥接。
3. 真实模型、销售计划详情和版本、审批权限与写回、通知、语音、桌面发布更新。这些不在本轮通过范围内。
4. 类型化 RPC 和桌面 transport：本轮只验证 Web Fetch。发布版的专用 `connection.rpc.handle` 注册在本次启动中报 `cannot get property "webServer" without inject`；采用已验证的认证 Fetch 注册后可运行。未经桌面实测，不能承诺同一传输无需适配即可复用。

结论支持继续采用外部业务插件的迁移方式。它证明了页面、服务接口和会话衔接的可行性；还不足以承诺 AionUi 所有功能都无需任何 dsh 扩展点改进。
