# Windows 插件详情页无法检查更新

用户已在 Windows 安装并实际加载 GEA 0.0.158，详情仍显示“当前平台不支持更新”。checkState 在读取签名频道之前按 win32 返回，安装路径也没有 Windows 进程树确认。158 仅完成 Mac store 修补，不能作为 Windows 在线更新验收。

本次让频道检查经过原签名、Core 和完整依赖图校验。安装仍调用官方 runProfilePnpm；Windows 使用固定 Core 的公开 Win32 Job API，在目标运行前纳入 kill-on-close Job，确认 Job 清空后才允许完成或恢复。无法证明停止时保持 unknown。回执、信任和恢复快照使用文件同步与 Windows 写穿移动，不忽略目录同步错误。

只检查更新器受影响文件，以及 Windows 原生的成功、实际 pnpm 安装、失败恢复和遗留子进程场景。不改 Core、业务接口、WeKnora 或用户配置。未验证或未发布的阶段不记为完成。已有 158 的平台拒绝逻辑不会因服务端发版自行改变，Windows 客户端需要先安装带适配的新插件，再检查后续更新。
