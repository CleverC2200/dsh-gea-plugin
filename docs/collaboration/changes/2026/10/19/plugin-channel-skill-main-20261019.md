<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261019-plugin-channel-skill-main","date":"2026-10-19","title":"三个 main 插件包发布及频道恢复","module":"客户端更新","status":"已发布"}
-->
# 三个 main 插件包发布及频道恢复

2026-10-19 用户明确选择只更新三个插件包及更新频道。本次发布到现有 OSS plugin-release/packages 及 plugin-detail-test、plugin-detail-stable。桌面安装包、GitLab 与 npm 不在本次范围。

旧 GEA 0.0.162 将桌面构建版本与 Core 运行版本直接比较，导致 UPDATE_CORE_VERSION_MISMATCH。修复已随 PR #98 进入 main。此前本机已通过官方 PluginManager 安装三个新包并重启，已安装、Host 和 client 版本一致；当时 stable 仍是 0.0.165 / 0.1.11 / company.20，因此返回 DOWNGRADE_FORBIDDEN。

本次刷新三仓 main 后打包。GEA 的 PR #99 增加运行环境准备检查与固定历史兼容 fixture，源码由 1b6922fa 前进到 64fbd1f6。重新构建后的运行文件及最终 tgz 与此前客户端安装文件一致。Manage、Workbench main 未变化。内容包括 Skill 目录编辑及系统目录选择、智能编排与销售计划资源、库存 Skill 和此前合入的更新。

| 插件 | 版本 | releaseSourceSha | artifactSha256 |
|---|---|---|---|
| workbench | 0.1.12 | `39204b03d5981974e8647b233e763ac20dc3de76` | `2619aa9614d0c5e10a7c290291838a75d02dd3e7d17991c531760855379ca463` |
| manage | 0.6.3-company.21 | `a6fc5793206e626956f6b4a0febacb52af1a853d` | `d04e20f7a3a41219d3d159fc1bd4a93a5413ca00bfe2e71c4a823e141f1c91eb` |
| gea | 0.0.166 | `64fbd1f6999ff589adb41b1c583fe5e4fdc9d03f` | `e63d2f7a22642bc6c8b7ebd79c2c4f46eb75b51b89c8e31f53cbfdba2ada5f9b` |

写入首个频道前，GitHub API 三仓 main 均与 releaseSourceSha 一致。test revision 17→20，stable revision 21→24。两频道使用原受信 Ed25519 key，均由实际 createPluginReleaseSource check/download 完成匿名签名验证、release JSON 摘要验证及全部三包下载校验。安装到当前桌面的包与远端发布包字节一致。

实际桌面 Core 8cfb899c 的完整证明通过生产 readPluginUpdateCore，读取 287 个 SDK 版本；按 GEA、Workbench、Manage 顺序，旧频道组合到新版本的每一步均为 ready，最终组合无兼容错误。此前的 SDK 观察缺少新增 skill-filesystem peer，已改用本次完整实际 Core 观察验证；失败输入保留在任务私有证据中。

发布后点击真实客户端“检查更新”，Manage 显示“已是最新版本”。公共状态接口确认三个包均 current、diagnostic=null，已安装、Host 和 client 版本一致。此阶段未再次安装或重启，未执行模型或业务验收；保留此前会话、草稿和配置。

仍使用有 Core 核验缺陷的旧 GEA 时，需要先在“插件管理→添加插件”手动选择新版 GEA tgz 完成引导升级，再按客户端提示刷新或重启，通过“检查更新”升级其余包。无需先卸载或删除用户数据。

发版 Skill 已与团队来源 2af64a7357f4a0287e6fb0f9dd455fcb8cb8855f 全文件比对。本机 0.9 与团队 0.8 有已审阅差异，涉及 TeamAI 分工、隔离和工作树/发布新鲜度；OSS 协议和工具摘要相同。状态 different-reviewed，未覆盖或分发本机修改。本次无新增运行源码修改、删除或历史修复回退。

源码 main 与发行库本地 main 使用受保护快进同步。发布后记录独立提交，待 PR 审阅；不改写发布源码或产物。源码修复及已通过的 CI 沿用 PR #38、#39、#98、#99，本阶段只做发布所需验证。
