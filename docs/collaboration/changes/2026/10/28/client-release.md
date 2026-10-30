<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261028-desktop-release-gea","date":"2026-10-28","title":"GEA 0.0.198 与双端桌面发行输入","module":"桌面发行","status":"待发布"}
-->

# GEA 0.0.198 与双端桌面发行输入

为最新双端桌面包固定 GEA 0.0.198，包含已经合并的官方 pnpm 整组更新与重启确认修复，并接纳 Workbench 0.1.37。0.0.197 已发布，使用新版本保留原归档字节。Mac 底包改为已发布的 20261024.3，其 Core 与当前 required 策略一致；原签名、Core 产物、下载摘要和隔离安装校验全部保留。

本轮构建 macOS arm64 DMG 与 Windows x64 NSIS EXE。构建、发布下载、实际安装与用户设备验收分别记录；CI 不代替真机更新验收。
