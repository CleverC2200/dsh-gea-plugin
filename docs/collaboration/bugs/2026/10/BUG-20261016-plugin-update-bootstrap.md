<!-- collaboration-record
{"kind":"bug","id":"BUG-20261016-plugin-update-bootstrap","date":"2026-10-16","title":"完整包新装后的在线更新缓存冲突及已有配置漏补来源","module":"插件更新","category":"安装升级","cause":"接线遗漏","severity":"P1","status":"修复中"}
-->
# 完整包在线更新接线

新装使用公司离线 store，但在线安装未显式沿用现有 node_modules 的 storeDir，pnpm 拒绝安装。只补装 GenUI 的已有 profile 又跳过更新来源初始化，详情页停在来源未配置。

0.0.158 候选从安装元数据选择现有 store，并在接受更新前拒绝缺失或不可用的缓存。初始化只补缺失来源，已有来源、WeKnora、禁用选择和旧回执保留。独立修复工具在官方 profile 锁内备份并补本地 workspace 设置，使旧更新器能安装新版本；活动、unknown 或未终结操作拒绝修复。

定向证据覆盖真实 pnpm 默认和公司缓存的下载、安装、新 Host/client 确认，已有 GenUI 初始化遗漏，以及 pnpm 11.7 的旧更新器引导。CI、合并、OSS 和实际客户端仍须分别读回。Windows 进程树安全适配与桌面重打尚未完成，保留平台拒绝，不将本次定向通过记为 Windows 在线更新可用。
