<!-- collaboration-record
{"kind":"bug","id":"BUG-20261112-windows-executable-rename","date":"2026-11-12","title":"品牌更名使 Windows 旧目录覆盖升级被拒绝","module":"客户端安装","category":"构建发布","cause":"原始遗漏","severity":"P2","status":"已修复待验证"}
-->

# 品牌更名使 Windows 旧目录覆盖升级被拒绝

Windows `.20261112.2` 候选的构建、首次安装和签名下载通过，但真实覆盖旧版安装器退出 2，未分发。原包定向重放确认 baseline 安装和版本检查成功、旧 `GEA Desktop.exe` 存在、新 `Synear GEA.exe` 不存在、目标进程数 0，随后 upgrade 阶段退出 2。

品牌更名改变了内部程序文件名。Core 的安装目录保护同时要求注册目录匹配和目标 EXE 存在，因此非空旧目录无法作为新名程序的已拥有安装处理；appId 未变。该问题不同于用户报告的重启后仍加载旧插件，后者原设备原因仍待确认。

[PR #377](https://github.com/CleverC2200/dsh-gea-plugin/pull/377) 通过官方 Windows executableName 保留历史 EXE 名，界面继续使用 Synear GEA；冒烟、安装测量和回执同步引用，失败信息区分安装阶段。原目录保护、签名、配置保留、版本及超时断言保留。19 项定向、实际 Builder 文件名验证及远端检查通过，已合并至 0e4bfc88eb68570c6f463b14d5c66bc380e98132。

[失败构建](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43066853423)、[定向重放](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43072695730)保留。Windows `.20261112.3` 的[固定源码签名构建和实际覆盖升级](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43074824213)通过，旧版安装器可覆盖升级至新版，安装签名有效、版本匹配、用户保留文件仍在。[修复版已发布](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/desktop-v0.2.0-rc.2.20261112.3)，员工设备未验收。Mac 不受该 Windows 文件名配置影响，复用已签名公证并发布的 `.20261112.2`。
