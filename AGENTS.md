# GEA 工程入口

先从项目根的 `docs/agents/current-development.md` 和本任务 `integration-set.json` 核候选 checkout，再读本仓 [README](README.md)。根同名仓库和旧发行资料是历史输入。候选检查不证明当前装载，也不授予运行或发布权限。

GEA Host 管唯一业务身份、凭据、Consumer 授权与受控执行；client 仅提供只读身份投影与账户动作。Workbench 管页面、布局和页面与 Session 的关联，Core 持有 Session 与用户草稿，Manage 管资源及纯计算。页面、Skill 可见与界面登录不授予服务端业务权限。

开发工具链、命令与公开导出以 `package.json` 为准，按 [本地开发说明](docs/local-development.md) 准备自己的依赖与输出。开发 pnpm 锁和普通 tgz 的 npm shrinkwrap 消费协议分别保留。质量检查范围与业务、模型、Native、安装及生产验收分别记录。

修改执行链时保留身份代际、已选资源、物理请求预算、失败、取消、部分和 unknown 的条件；凭据留在 Host。注释清理不得改 Prompt、Skill、运行时字符串、schema、法律来源或工具指令。历史材料不用于自动推断当前支持行为，见 [历史入口](docs/history/README-pre-agent-environment-04.md)。

本项目只允许隔离开发，不向正式 GitLab、OSS、npm 或频道写入，不改正式客户端。旧公司桌面源码与发行协议保留为历史输入；当前官方客户端组合按 [验证说明](docs/plugin-split-validation.md) 处理，执行仍须有本窗口授权。

普通三包交付从 [打包与接收入口](docs/package-delivery.md) 进入。以下约束由实际入口执行，阶段结论仍分别记录。

| 交付规则 | 执行机制 |
| --- | --- |
| 可安装三包的资源、完整官方预设和 SDK 实例须在新普通 profile 接收 | `delivery:reception` 串行官方安装与 Loader 观察；`plugin-reception/contract.mjs` 统一接受投影与回执绑定；`test:delivery:packages` 重放真实 APS/Sales 失败 |
