# GEA 静态架构入口

当前职责与运行入口见 [README](README.md)，执行链见 [GEA 执行逻辑](docs/execution-logic.md)。构建入口和公开导出以 [package.json](package.json) 与 [build.mjs](scripts/build.mjs) 为准。

原 Archify 图把页面、输入及桥模块放在 GEA 仓库，已不对应当前拆分归属。原图、统计、生成提示与未验收说明按原字节保存在 [历史架构快照](docs/history/current-docs-before-20261010/archify.md)。它的 `.archify` 数字只描述当时索引，不能作为本 checkout 的当前架构证据。

本仓负责身份、Consumer、授权与受控执行。页面、Native/HTML 呈现、动作、引用和页面与 Session 的关联由同组 Workbench 负责；资源与纯计算由 Manage 负责；持久 Session 与草稿由 Core 负责。跨仓接口见 [Workbench 合同](../dsh-agent-workbench/docs/workbench-contracts.md)。

静态源码阅读不证明安装、Native、真实数据、模型、审批事务或正式 DMS 已验收。
