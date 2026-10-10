# GEA 工程入口

先从项目 [项目开发导航](../../../../docs/agents/current-development.md) 和本票 `integration-set.json` 核同组三仓 checkout、提交与未提交改动，再读本仓 [README](README.md)。根同名仓、原公司壳与旧发行记录按 [文档索引](docs/index.md) 追溯。

修改身份、Consumer、额度、取消或业务执行时，读 [执行链](docs/execution-logic.md) 与 [能力声明](docs/capability-contract.md)。GEA Host 为唯一身份与凭据权威；页面和页面/Session 关联归 Workbench，资源及纯计算归 Manage，持久 Session 与草稿归 Core。凭据、失败、取消、部分和 unknown 按原执行合同保留，原业务规则和用户数据不因工程整理改变。

准备开发依赖与构建时读 [本地开发](docs/local-development.md)，实际工具链、scripts、exports 和锁以仓内配置为准。启动及组合切换读 [源码组合](docs/plugin-split-validation.md) 与 [窗口准入](docs/window-launch-admission.md)，输入检查不证明装载，也不产生运行授权。

普通三包交付读 [打包与接收](docs/package-delivery.md) 和 [安装协议](docs/install.md)。收尾前读 [交付核对](docs/delivery-check.md)，按原规格核完整目标、在途工作、预算、依赖及暂停；一致性、packaged、Host 接收与业务验收分别留证。自动工具不授予授权或自动接续。

只在本任务隔离 checkout 与自有输出工作。正式 GitLab、OSS、npm、频道、原同名仓和正式客户端保持保护；旧文档中的发行步骤不覆盖此边界。业务 Prompt/Skill、运行时字符串、schema、法律来源、用户 Session、草稿及原失败证据保持原归属。

修改异步工具结果、证据持久化或回读时，读 [执行链](docs/execution-logic.md) 的执行归属合同与 [本地检查](docs/local-development.md)。迟到结果只归原执行；身份、轮次或资源变化后，保持原数据与失败证据，按当前归属决定能否发布。
