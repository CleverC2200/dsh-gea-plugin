# 页面桥与 GEA 执行边界

页面目录、通用动作、HTML MessageChannel、引用与页面/Session 关联由同组 Workbench 持有，接口权威为 [Workbench 页面合同](../../dsh-agent-workbench/docs/workbench-contracts.md) 与 [呈现恢复](../../dsh-agent-workbench/docs/presentation-recovery.md)。页面贡献者使用该仓公开接口；GEA 不再维护 `src/page-bridge` 或从页面 DOM 派生能力。

GEA 从 Workbench 登记的包元数据读取明确 page/capability 声明，按 [能力合同](capability-contract.md) 核 Consumer、影响等级、启用状态和真实业务授权。[HTML adapter](../src/html-plugins.ts) 通过公开业务页面注册提供 grant；实际页面端口、owned lease 的使用/关闭、self-report/catalog/apply/cancel 和工具释放归 Workbench。Native 审批保持原业务调用链，不强制套用 HTML lease。

GEA 身份变化撤销旧授权与在途请求；Workbench 释放旧端口与页面关联，Core 保留 Session 和草稿。保存引用、插入前校验和恢复分别按当前 Workbench/GEA 接口核对，不能把恢复回执等同于引用正文已可读。

当前业务角色沿 [标准能力边界](business-standard-capabilities.md) 使用官方 standard。GEA 只约束自身业务工具；旧业务会话全局禁止浏览器/终端的规则已退出。页面动作声明不授予审批或正式写入权限，仍由实际业务 Host 和服务端复核。

[原页面桥全文](history/current-docs-before-20261010/docs/page-bridge.md) 保留旧 AG-UI 轮询、旧动作格式、扫描回退、常量、接入步骤和当时未完成项，仅供追溯。按原路径接入页面、自动派生 capability 或恢复旧工具禁用都不是当前协议。
