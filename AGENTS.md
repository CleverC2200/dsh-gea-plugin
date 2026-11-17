# GEA 开发入口

先核本次任务登记的 checkout、HEAD 与未提交改动。工具链、命令、锁与公开导出从 [package.json](package.json) 读取；[README](README.md)提供当前产品入口。

GEA Host 是业务身份、凭据、Consumer 授权和受控执行的 owner。身份、取消、异步结果与业务写入读[执行链](docs/execution-logic.md)和[能力合同](docs/capability-contract.md)。迟到结果只归原执行，client 只提供身份只读投影。页面归 Workbench，资源与纯计算归 Manage，Session/草稿归 Core。

代码用命名、类型、结构和必要行为测试表达规则，自有源码、脚本与测试不写注释；业务 Prompt/Skill 与运行时文案保持原含义。工具指令先消除依赖，许可证来源按原分发要求保全。`check:comments` 默认阻断全仓自有代码注释，支持范围和资产来源见 `source-comments.json` 与[本地开发](docs/local-development.md)。第三方、生成物、业务资源、fixture 与历史证据按真实来源保留。

本地检查读[本地开发](docs/local-development.md)，影响计划与构建读[开发构建入口](docs/development-builds.md)。插件拆分项目内先按根 `docs/agents/dependency-preparation.md` 选择源码反馈或安装验收；复用已准备环境，不修改共享 SDK 和他人产物。

三包打包与 Loader 接收读[普通交付](docs/package-delivery.md)，桌面发版读[桌面交付](scripts/desktop-release.md)。源码、离线检查、实际装载、业务与发布结果分别留证；Core 兼容清单和 CI 策略从对应配置读取，旧报告不作为当前状态。

仅修改本任务工作区。GitLab source、正式 OSS/npm/频道、正式客户端、用户 Session/草稿及原始失败证据保持保护；远端或业务写入按本次有效授权执行。未解决的业务合同见[文档入口](docs/index.md)，不因历史文件清理而关闭。
