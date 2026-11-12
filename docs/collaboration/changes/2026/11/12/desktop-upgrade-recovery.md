<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261112-desktop-upgrade-recovery","date":"2026-11-12","title":"修复恢复旧插件后再次安装无法启动","module":"客户端更新","status":"已发布"}
-->

# 修复恢复旧插件后再次安装无法启动

修复[重复升级备份冲突](../../../bugs/2026/11/BUG-20261112-repeated-bundled-refresh.md)。每次升级保留独立恢复材料，避免恢复旧插件后再次安装因配置差异而打不开。成功判定、失败恢复限制及用户数据保留要求沿用原协议。

[PR #386](https://github.com/CleverC2200/dsh-gea-plugin/pull/386) 已合并，PR 与合并后 main 的必要 CI 通过。升级与交付相关 143 项本地测试通过，真实 pnpm 回放及 Mac 独立临时签名包覆盖安装、三次重复启动通过。

双端正式签名客户端 [0.2.0-rc.2.20261112.4](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/desktop-v0.2.0-rc.2.20261112.4) 已发布，固定源码为 `058c553187862f8769beaf3d9b39f59ff2237c24`。[Mac 构建](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43163315840)完成签名、公证和装订；[Windows 构建](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43163319325)完成签名、旧安装器覆盖安装、恢复旧插件后再次升级、三次打包启动器启动和三次原生窗口启动。两端公开安装包均完整读回并核摘要，来源清单、插件 Release 与组合核验已完成。插件复用 Workbench 0.1.97、Manage 0.6.3-company.66、GEA 0.0.274、个人记忆 0.1.2；stable 103 / test 111 未改变。客户端本轮发布安装器及来源清单，自动更新频道保持原状态。

Windows 实机独立目录覆盖安装及连续三次原生窗口启动通过，插件版本、安装声明、配置和测试数据保留。实机原安装、个人配置、注册信息和快捷方式保全，临时验收任务已移除。实机发现 PowerShell 5.1 默认中文编码无法解析 UTF-8 包信息，验收夹具改为显式 UTF-8 后通过。该补修只影响验收脚本，已发布客户端字节保持原样。

[本版更新说明](https://klvcodtump.feishu.cn/docx/UnfAdaKJWoSzyzxK2Djco35vnxf)修订 3 已回读；[安装指南](https://klvcodtump.feishu.cn/docx/W85mdQbvhokGkIxPm1vcNUICn2T)修订 260 仅更新双端下载链接。原故障员工资料原位升级、真实账号登录和历史业务会话未验收。

发布技能采用本机 dsh-plugin-release 1.3.1 local_draft，未登记团队维护源。本次用户已授权 PR、检查后合并、修正版客户端发布和 Windows 覆盖安装及重复启动验收。
