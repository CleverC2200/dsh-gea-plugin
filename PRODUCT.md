# GEA 插件产品职责

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

业务人员在公共 Workbench 中使用当前已授权的销售计划、库存、通知和分析能力；开发与联调人员核对 GEA Host 的真实上游调用。

## Product Purpose

GEA 为这些页面与 Agent 提供唯一业务身份、凭据、Consumer 授权和受控执行。服务端身份、权限和业务状态为最终权威。页面可见、Skill 可见、登录展示与本地回执均不能代替业务授权或真实验收。

## Positioning

GEA Host 持有认证与网络边界，client 发布只读身份投影和账户动作。Workbench 持有页面、公共布局、动作、引用及页面与 Session 的关联；Manage 持有资源和纯计算；Core 持有 Session 与草稿。职责入口见 [README](README.md)。

## Operating Context

当前官方客户端、固定 Core、源码组合和普通插件包按任务冻结输入与 [安装说明](docs/install.md) 核对。历史公司桌面壳按 [文档索引](docs/index.md) 分类追溯，其发行说明不授予本隔离项目正式发布权限。

## Capabilities and Constraints

执行条件与失败语义见 [执行逻辑](docs/execution-logic.md) 和 [能力声明](docs/capability-contract.md)。接口日志由 [Host 实现](src/host/api-log.ts) 记录和脱敏，页面由 Workbench 呈现。重发沿该实现的当前身份代际、目录策略、原正文及幂等检查；不能把日志中心用作任意请求入口。

## Evidence on Hand

源码与配置可以证明实现归属；安装、Native、真实模型、业务写和 DMS 分别读取同次证据。[风险与历史入口](docs/index.md) 保留尚未完成的验收。旧产品说明按原字节保存在 [产品快照](docs/history/current-docs-before-20261010/PRODUCT.md)。

## Product Principles

业务读取保留来源、时间、环境、精度和覆盖范围。拒权、失败、取消、部分结果与 unknown 分别表达。凭据留在 Host，退出和身份变化撤销旧执行条件，用户的 Core Session 与草稿保留。
