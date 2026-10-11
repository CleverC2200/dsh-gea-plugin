# 交互与引用授权入口

当前页面动作、引用捕获、保存代次、输入插入与恢复由同组 Workbench 的 [页面合同](../../dsh-agent-workbench/docs/workbench-contracts.md) 和 [呈现恢复](../../dsh-agent-workbench/docs/presentation-recovery.md) 维护。GEA [Host](../src/host.ts) 和 [Business](../src/host/business.ts) 核真实业务身份、Session、页面上下文与执行权限；client 只发布 [只读身份投影](../src/business-identity-client.ts)。

Native 真实/计划原型按实际 surface 与 Host 菜单上下文授权，不新增 HTML lease。真实 HTML 引用按 owned lease、Session/plugin 与当前环境、用户、租户、登录代际核 owner；mock 按其明确 mock 合同保留有效 Core Session 与引用生命周期，不强制申请真实 Gateway 身份。旧真实 owner 不能靠声称 Native 或 mock 绕过。具体允许入口和错误由当前源码与 Workbench 合同定义，不从历史名单扩展。

引用快照、保存授权与插入前校验是不同步骤；回执恢复不保证冷重启后正文可读。身份变化撤销旧请求与授权，页面重新关联仍保留原 Core Session 与草稿。真实业务写入另行复核当前数据和服务端权限。

[2026-09-30 原契约与删除进度](history/current-docs-before-20261010/docs/interaction-permission-contract.md) 按原字节保留，包含当时四个 Native 入口、HTML/mock 分支、删除清单、测试范围与未完成迁移。当前公共实现已迁至 Workbench，不使用其中的 GEA `packages/page-interaction` 路径或固定名单定位本 checkout。页面改动沿 Workbench 公开合同实施，原未完成业务迁移继续按对应环境验收。
