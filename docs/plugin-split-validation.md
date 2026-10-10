# 当前官方客户端与源码组合验证

源码组合的 Core 输入由 [当前源码 Core 声明](../scripts/current-core.json) 和本票冻结记录共同确定，通过标准官方构建提供 SDK/客户端产物。Core源码和产物不做本地补修；官方客户端使用其标准 `pnpm dev:desktop` / `pnpm start:desktop`。Web/离线测试只提供开发反馈，不替代最终正式UI同源与实际客户端验收。普通三包的双版宿主与SDK支持另由 [supported-cores.json](../scripts/supported-cores.json) 登记，并通过 [安装/Host接收](package-delivery.md) 核各自唯一SDK实例；源码组合的选择不缩小或替代普通包支持。

源码组合只有既有 Workbench、Manage、GEA、GenUI、Better Sidebar；它们由自己的官方bundle/profile入口装配，GEA patch只登记业务接入本身。官方插件生命周期与Manage Suite/Skill/MCP资源状态分开。原资源窄source贡献、业务算法/权限/取消保持，官方standard preset不重写。

`source-profile.mjs`是唯一assembler：固定sources可声明source、commit、integration，以及需复用的assets/files和dependencies。新prepare/check/build必须明确提供同一五源records；缺来源在SDK扫描/写入前拒绝，不存在workspace/sibling默认。源包name须匹配登记owner，source和integration必须clean且一致；只复制发布资产、不复制依赖或SDK。corePackages供同一type/check/build/组合链解析官方包。声明assets/files时统一校验全部发布文件与必要host/client/patch入口，不tsc/build冻结资产；损坏拒绝且不重建。普通source按原工具链执行；已选历史完整组合读回不要求新records。每次组合记录原件及实际依赖hash，选择在独占锁内通过CAS、原子写入、读回验证；unknown不自动重写/回滚。

```sh
corepack pnpm run source:check --sources /absolute/fixed-sources.json
corepack pnpm run source:build --sources /absolute/fixed-sources.json
corepack pnpm start --window /absolute/open-window.json --case <existing-case> --owner <existing-owner> --freeze-sha256 <actual-sha256> --config /absolute/deployment.json --runtime /absolute/owned-runtime --port 0
```

启动前先按 [窗口准入](window-launch-admission.md) 完成离线冻结和本窗口声明；缺声明也拒绝，不以旧窗口或省略 window 绕过。首次 prepare/选择入口与新五源冻结方式见该文。不得让源准备过程改user profile。模型默认seed写入新snapshot，真正launcher在自己的profile以flagwx采用；已存在用户选择保持。正常真实客户端/组合切换由root串行执行。workflow Host定向fixture仅临时home/profile、loopback服务和port0，不能接真实GEA、模型或生产端点；记录它自己的PID并清理，不触root/旧运行。

旧Hub/example、source-presets及旧reader的装配路径不在当前组合。历史公司桌面壳源码及仍被其使用的preset helper/测试不属此次官方客户端目标；保持原件，不重做其兼容，不把当前源码门禁说成旧壳发布/验收。

current source-profile直接调用businessDeploymentPatch，仅给GEA真实业务/模型配置；旧公司desktop仍调用deploymentPatch中的历史UI/preset装配，业务声明共享现有module同一规则，不把旧helper带进最新source启动。

新生成的 source 组合将官方 `agent-preset-registry.default` 设为 `auto-negotiation`，由 Manage 以固定官方 standard 组合提供“智能编排”。生成补丁不写 `selectedDefault`，官方仍优先采用用户保存的选择。因此已有 `selectedDefault: minimal` 的 profile 不会仅因准备新组合而切换默认；获准的运行采用阶段须经官方设置保存指定选择并核对 effective default。源码组合准备不修改用户 profile、已有 Session 或草稿，也不证明候选已经装载。

生成的源码检查保留各项目声明的补充类型路径，并按该项目目录与 baseUrl 解析。固定 Core 与已登记跨仓类型映射始终优先，项目路径不能替换这些映射。原发布资产仍只校验和复用，不重新编译。

本项目 GEA 的开发安装将 GenUI 指向固定原 npm 0.11.3 发布资产，将 Better Sidebar 指向原样 e35120f1d9b3773062b68decb4f53a526d6c8baa checkout，退出同级产品 fork 的依赖声明。Sidebar 策略测试通过上游已公开的 `dsh-better-sidebar/src/*` 导出读取注册逻辑，不再拼接同级源码路径。冻结资产不重建；上游源码与发布文件摘要仍由明确五源记录校验，开发依赖路径不成为新的装配默认。

当前官方源码启动只走 `businessDeploymentPatch` 和明确的五源输入。历史 `deploymentPatch` 的依赖解析用途仍单独保留，本片不改旧桌面发行协议。普通包的 shrinkwrap 与实际 profile 锁沿 [安装协议](install.md) 和 [三包打包与接收](package-delivery.md) 执行；源码组合不替代普通包接收。原运行组合和恢复材料不删除，真实 Agent 推送验收未通过时不提前关闭来源退场。

`GET /api/gea-proof/sidebar-tool-visibility?sessionId=<existing Session id>` 提供当前 Host 的最小只读工具投影。GEA 必须已登录，Session 对应的 Agent 必须已存在；未就绪返回明确错误，不创建或恢复 Agent。返回 `sidebar_open` 的注册与该 Agent 当前 scoped Tools 可见性，不提供执行入口，不调整工具策略、不发模型请求或外部业务查询。结果只描述读取时刻，不能代替随后真实工具返回、推送、队列及释放验收。读取无缓存，不返回身份、凭据或工具参数内容。
