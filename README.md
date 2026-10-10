# GEA 身份与受控执行插件

先从项目 [项目开发导航](../../../../docs/agents/current-development.md) 与本票 `integration-set.json` 核同组三仓 checkout、提交和未提交改动。源码候选、选中组合和当前窗口实际装载分别留证；原同名根仓仅供追溯。

GEA Host 管唯一业务身份、凭据、Consumer 授权、执行额度与受控接入。client 只提供身份投影与账户动作。Workbench 管页面、Native/HTML 呈现、公共布局、页面动作、引用及页面与 Session 的关联；Manage 管 Agent/Prompt/Skill/MCP/LSP 资源和纯计算；Core 管 Session、草稿、预设、历史和持久生命周期。领域词汇见项目 [共享词汇](../../../../docs/agents/GLOSSARY.md)。

## 按任务阅读

| 任务 | 权威入口 |
|---|---|
| 全仓文档、业务规格与未验收风险 | [文档索引](docs/index.md) |
| 身份、Consumer、请求额度、取消、分析与业务写 | [执行逻辑](docs/execution-logic.md)；一手入口为 [Host](src/host.ts) 和 [Business](src/host/business.ts) |
| HTML page/capability 声明、启用与 mock | [能力声明](docs/capability-contract.md) |
| 页面接入、动作、引用与恢复 | [页面桥入口](docs/page-bridge.md)，沿同组 Workbench 公开合同 |
| 业务资源与官方 standard 的执行边界 | [标准能力边界](docs/business-standard-capabilities.md) |
| 工具链、依赖、构建与静态知识检查 | [本地开发](docs/local-development.md)，精确命令与导出以 [package.json](package.json) 为准 |
| 五源组合与实际启动 | [源码组合](docs/plugin-split-validation.md)，启动前读 [窗口准入](docs/window-launch-admission.md) |
| 普通三包打包、安装与 Host 接收 | [三包交付](docs/package-delivery.md) 和 [安装协议](docs/install.md) |
| 回执一致性、预算、完整目标与接续 | [交付核对](docs/delivery-check.md) |

## 完成边界

登录、退出、过期、切用户/租户/环境由 GEA Host 统一处理。页面、Skill 与界面登录展示均不授予服务端权限。凭据留在 Host；身份变化撤销旧执行条件，Core Session、历史与草稿保留。真实读取、缺字段、拒权、不完整结果、取消与 unknown 不能补成零或成功。

源码检查、离线 fixture、远端 CI、packaged、普通安装/Loader 接收、Native、Windows、真实数据、模型与业务写分别报告。交付核对只证明其声明范围的一致性或阶段完成，须按原规格核完整目标，不能缩小声明获得通过。历史回执不证明当前窗口仍运行、登录或装载。

本目录只允许隔离开发，不向正式 GitLab、OSS、npm 或频道写入，不改原同名仓或正式客户端。启动、真实查询、模型和业务写继续按有效窗口授权执行。旧公司壳和正式发行材料按 [索引](docs/index.md) 条件化追溯，不作为当前安装或写入授权。
