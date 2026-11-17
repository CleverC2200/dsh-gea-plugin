<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261112-desktop-upgrade-recovery","date":"2026-11-12","title":"修复恢复旧插件后再次安装无法启动","module":"客户端更新","status":"已发布"}
-->

# 修复恢复旧插件后再次安装无法启动

修复[重复升级备份冲突](../../../../bugs/2026/11/BUG-20261112-repeated-bundled-refresh.md)。每次升级保留独立恢复材料，避免恢复旧插件后再次安装因配置差异而打不开。成功判定、失败恢复限制及用户数据保留要求沿用原协议。

[PR #386](https://github.com/CleverC2200/dsh-gea-plugin/pull/386) 已合并，PR 与合并后 main 的必要 CI 通过。升级与交付相关 143 项本地测试通过，真实 pnpm 回放及 Mac 独立临时签名包覆盖安装、三次重复启动通过。

双端正式签名客户端 [0.2.0-rc.2.20261112.4](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/desktop-v0.2.0-rc.2.20261112.4) 已发布，固定源码为 `058c553187862f8769beaf3d9b39f59ff2237c24`。[Mac 构建](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43163315840)完成签名、公证和装订；[Windows 构建](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43163319325)完成签名、旧安装器覆盖安装、恢复旧插件后再次升级、三次打包启动器启动和三次原生窗口启动。两端公开安装包均完整读回并核摘要，来源清单、插件 Release 与组合核验已完成。插件复用 Workbench 0.1.97、Manage 0.6.3-company.66、GEA 0.0.274、个人记忆 0.1.2；首次发行复用当时 stable 103 / test 111 组合。后续客户端自动更新沿用上述固定产物与内置版本，未改写插件频道。

Windows 实机独立目录覆盖安装及连续三次原生窗口启动通过，插件版本、安装声明、配置和测试数据保留。实机原安装、个人配置、注册信息和快捷方式保全，临时验收任务已移除。实机发现 PowerShell 5.1 默认中文编码无法解析 UTF-8 包信息，验收夹具改为显式 UTF-8 后通过。该补修只影响验收脚本，已发布客户端字节保持原样。

[本版更新说明](https://klvcodtump.feishu.cn/docx/UnfAdaKJWoSzyzxK2Djco35vnxf)修订 7 已回读；[安装指南](https://klvcodtump.feishu.cn/docx/W85mdQbvhokGkIxPm1vcNUICn2T)修订 260 仅更新双端下载链接。该轮独立安装未覆盖个人正式资料；后续正式资料验收见下文。

发布技能采用本机 dsh-plugin-release 1.3.1 local_draft，未登记团队维护源。本次用户已授权 PR、检查后合并、修正版客户端发布和 Windows 覆盖安装及重复启动验收。

用户随后授权推进客户端自动更新频道。Mac 从 .20261112.2、Windows 从 .20261112.3 使用真实 `electron-updater` 下载正式公网载荷、通过平台验签并完成原生替换，新版 .20261112.4 窗口正常显示。自定义轮询配置、浏览器偏好以及真实持久会话中的用户消息和回复保留。测试会话由旧版内置 Core 写入六个事件，并由新版内置 Core 完整回读；仅运行时完整性证明按新版 seed 刷新，其余配置核对一致。

发布前使用私有 loopback 清单驱动验收，重开由脚本控制以隔离正式资料。双端正式频道已推进到 .20261112.4，清单与验收输入逐字节一致，所有载荷再次匿名完整读回并核摘要。[不可变更新回执](https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/058c553187862f8769beaf3d9b39f59ff2237c24/desktop/Synear-GEA-0.2.0-rc.2.20261112.4-auto-update-verification.json)记录协议与验收范围。原个人安装和关键配置保全，Windows 注册信息、快捷方式恢复且临时任务移除。该轮尚未覆盖产品更新弹窗中的自动重启交互、真实账号登录和历史业务会话，后续结果如下。

随后按用户授权，在双端原正式安装和个人资料中完成真实更新界面验收。Mac .20261112.2 点击待重启更新入口，Windows .20261110.3 依次点击更新页和真实“安装并重启”弹窗，均使用正式公网频道升级到 .20261112.4 并自动显示正常窗口。升级后未由验收脚本启动客户端，未拦截更新器或改变自动重启参数；Windows 观察到安装后的新进程携带 `--updated`，签名有效且安装位置不变。两端进入工作台后均恢复原账号，无需重新认证，更新页均显示本版且已是最新版。

新版内置 Core 完整读回 Mac 原有 29 个会话、963 条事件及 Windows 原有 19 个会话、72 条事件。所有原会话头和原事件保持一致，Mac 另打开了一条旧会话界面。两端用户配置逐项一致，仅运行时完整性证明按已核验的新版 seed 刷新。实际运行插件分别为 Mac Workbench 0.1.98 / Manage company.66 / GEA 0.0.275，Windows Workbench 0.1.99 / Manage company.67 / GEA 0.0.276，包含原先排队或通过本次正常更新入口接收的插件更新，与客户端内置种子版本分开记录；本阶段未改写插件频道。

[完整界面更新验收回执](https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/058c553187862f8769beaf3d9b39f59ff2237c24/desktop/Synear-GEA-0.2.0-rc.2.20261112.4-full-ui-update-verification.json)另行保存正式资料、界面操作与自动重启结果，原隔离验收回执保持不变。原始配置、会话和截图仅私有保全，公开回执只含汇总。双端保持新版正常打开，Windows 临时验收任务已移除，调试端口已关闭。本轮只验证升级、启动、账号恢复和历史资料保留，未新增生产业务提交。

按用户要求，后续客户端发版回归接入[桌面发布合同](../../../../../../scripts/desktop-release.md)。发布器将上传完成与完整界面验收分开，新增双端收尾核验入口；旧、新版内置 Core 可通过复用工具逐项核对用户配置和全部原会话。缺平台、错版本或产物、脚本重开、配置与会话未通过均拒绝，相关回归及选测接入现有 CI。新数据工具对本次双端升级前私有快照和现已安装的 .4 再次核对通过，原有 29 / 19 个会话和 963 / 72 条事件均保留；原界面自动重启证据复用本次实机结果，未再次安装客户端。本机发布技能入口同步为 1.3.2 local_draft，未发布团队 Skill 包；共享合同以仓内文档和检查入口为准。
