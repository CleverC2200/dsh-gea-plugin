<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261112-client-update-takeover-release","date":"2026-11-12","title":"原生接管重启更新与新版客户端","module":"客户端更新","status":"已发布"}
-->

# 原生接管重启更新与新版客户端

本轮已完成真实隔离验证、PR 检查合并和签名客户端发布。相对上次实际分发的 0.2.0-rc.2.20261109.2，本版改为一次点击后由客户端接管安装、禁止普通窗口操作并自动重启；覆盖安装按完整三包恢复；正式环境隐藏灰色业务占位菜单，测试环境保留。

| 组件                    | 固定输入                                 | 合并与检查                                                                                                                                                                        |
| ----------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core                    | 0accab310546c1bc8d3ad46b8803dcbcfaa02477 | [PR #28](https://github.com/CleverC2200/deepseek-harness/pull/28)，主线 9b947af6 与源树相同；本地完整构建、类型检查、43 项文档门禁和 163 项生命周期测试通过，无公司分支 hosted CI |
| GEA 0.0.269             | 6f7cfd42a8813e7a9a9998debde1b42a002a036f | [PR #373](https://github.com/CleverC2200/dsh-gea-plugin/pull/373)，[40 项源码分片检查](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43057191153)通过                |
| Workbench 0.1.92        | 73617321de489b876594370bd818aa29c33db93f | [PR #295](https://github.com/CleverC2200/dsh-agent-workbench/pull/295)，源码及合并主线检查通过                                                                                    |
| Manage 0.6.3-company.64 | 7d44bb8956036efb22254b7d7f791fb1dd6306d4 | 复用已发布的原归档字节                                                                                                                                                            |
| 个人记忆 0.1.2          | bcc2c92523a964ad2733f5c68390f83361d5b256 | 已合并主线；27 项单测、4 项固定 Core/Host 集成和生产归档检查通过                                                                                                                  |

Mac 发行源为 GEA 1053499ba7951735a3013de7690292a48cb9c939；Windows 修复版发行源为 0e4bfc88eb68570c6f463b14d5c66bc380e98132，包含 [PR #374](https://github.com/CleverC2200/dsh-gea-plugin/pull/374) 的 Windows 产品更名验收定位修复。产品 appId 保持一致，验收从构建回执定位新版主程序；Windows 修复版内部名继续使用 GEA Desktop.exe。相关 PR 检查通过，签名包原生验收按平台分别记录，原版本、签名、文件保留及超时断言继续执行。

真实隔离 Electron 已完成一次公开按钮点击、HTTPS 下载、官方安装、普通窗口禁用和自动重启，新进程安装/Host/client 版本一致，保留文件仍在。该演示使用本地验收版本，不包含业务登录和真实模型调用。三包交付、四插件官方安装与实际 Host 加载、完整消费者发布预检均通过。测试频道 revision 108、正式频道 revision 100 已由生产来源读取器完整下载校验。

累计纳入欢迎页重复认证修复、会话反馈与请求日志关联、库存卡片/列表口径与分仓加载、订单首批数据及取消读取、模型容量与长对话整理恢复，以及个人记忆召回与引用来源修复。累计源码变更不等于本轮所有业务逐项实机验收。

Mac 首次签名封装被原 afterPack 拒绝：品牌化主进程单文件 FileSet 被 Builder 忽略。实际 Builder 文件收集重现为 0；[PR #375](https://github.com/CleverC2200/dsh-gea-plugin/pull/375) 改目录 FileSet 后收集到目标 `lib/main.js`，19 项定向检查及远端检查通过并合并。失败候选 `.20261112.1` 的标签与日志保留，未发布；双端改用 `.20261112.2` 重新构建。

本轮 CI 准备曾因 Ubuntu APT 镜像 DNS 失败而未进入测试；改用保留 Ubuntu 签名验证的 HTTPS 镜像和失败即停的索引刷新后，完整源码检查通过。过时夹具按当前兼容和正式菜单行为修正，原测试断言未跳过。失败及取消运行保留，不计为通过。

[Windows 覆盖安装问题](../../../../bugs/2026/11/BUG-20261112-windows-suite-recovery.md)的原设备升级仍待验收，尚未取得原故障回执。Windows 托管环境的旧安装器覆盖升级和历史插件恢复已通过，不能据此确定原设备根因。历史修复未回退，未操作正式用户配置或 Session；灰色正式菜单隐藏为本次明确要求。

发布技能为本机 dsh-plugin-release 1.3.1 local_draft，未登记团队维护仓，本轮未声称技能同步。已刷新五仓发布主线并查阅客户端更新相关同事记录；独立待审需求不纳入本轮。

全量协作索引生成被既有历史记录的分类字段拒绝；本轮保留同事原记录和原索引，从文档索引直接进入本页，不在发版中迁移历史元数据。

Mac 0.2.0-rc.2.20261112.2 已完成 Developer ID 签名、App/DMG 公证装订、打包运行时与隔离 profile 的插件首次初始化冒烟，安装包与在线更新载荷均已匿名完整读回校验。[Mac DMG](https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/1053499ba7951735a3013de7690292a48cb9c939/desktop/Synear-GEA-0.2.0-rc.2.20261112.2-mac-arm64-signed.dmg)，408495259 字节，SHA-256 为 12d88ecf93819e25c8e9fcb43acf08c05bc47a1956b913f261ddf2030561a7d5。未执行向 /Applications 拖拽安装的 GUI 验收。

Windows `.20261112.2` 的签名构建、插件首次初始化、历史插件恢复和签名更新下载通过，覆盖升级退出 2，未发布。原包定向重放确认旧版安装成功、旧 EXE 存在、新名不存在且无目标进程；[程序更名兼容问题](../../../../bugs/2026/11/BUG-20261112-windows-executable-rename.md)由 [PR #377](https://github.com/CleverC2200/dsh-gea-plugin/pull/377) 修复并通过检查合并。Windows `.20261112.3` 的[签名构建及完整验收](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43074824213)通过，包括旧版未签名安装器覆盖升级、新版签名与版本、用户保留文件、历史三包恢复和打包运行时。Mac 复用已验证的 `.2`；Core 和四插件归档相同，平台版本和源码分别记录。

[Windows EXE](https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/0e4bfc88eb68570c6f463b14d5c66bc380e98132/desktop/Synear-GEA-0.2.0-rc.2.20261112.3-win-x64-signed.exe) 为 320772600 字节，SHA-256 为 e5a28827c40c8cb5da3c2d4a3581cafa40b978510dd006253b4ea6e3be7223d8。安装器、blockmap 与 Electron 更新 feed 已发布并匿名完整读回。平台不可变来源清单可查 [Mac](https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/1053499ba7951735a3013de7690292a48cb9c939/desktop/Synear-GEA-0.2.0-rc.2.20261112.2-mac-arm64.manifest.json) 与 [Windows](https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/0e4bfc88eb68570c6f463b14d5c66bc380e98132/desktop/Synear-GEA-0.2.0-rc.2.20261112.3-win-x64.manifest.json)。正式安装包的生产 feed GUI 全流程和员工实际账号、历史会话未验收。

[客户端发行记录](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/desktop-v0.2.0-rc.2.20261112.3)与 [Mac 发行记录](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/desktop-v0.2.0-rc.2.20261112.2)均已发布。插件记录分别为 [GEA 0.0.269](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.269)、[Workbench 0.1.92](https://github.com/CleverC2200/dsh-agent-workbench/releases/tag/v0.1.92)、[Manage 0.6.3-company.64](https://github.com/CleverC2200/dsh-agent-manage/releases/tag/v0.6.3-company.64) 和 [个人记忆 0.1.2](https://github.com/CleverC2200/dsh-personal-memory/releases/tag/v0.1.2)。Manage 保留原归档和记录，仅补当前 Core 兼容说明。

[本版更新说明](https://klvcodtump.feishu.cn/docx/W9CAd1pRdo0F2vxerbeccUOknWe)创建后已读回 revision 3；[固定安装指南](https://klvcodtump.feishu.cn/docx/W85mdQbvhokGkIxPm1vcNUICn2T)仅替换双端下载链接并读回 revision 258，其他资源保留。未发送群通知。
