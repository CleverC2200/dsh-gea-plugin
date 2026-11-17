<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261102-mac-offline-bootstrap","date":"2026-11-02","title":"修复 Mac 内置三包离线安装及超时恢复","module":"客户端安装","status":"待提交"}
-->

# 修复 Mac 内置三包离线安装及超时恢复

基线为 GitHub main 的 035976f2。用户要求查清本地依赖齐全仍联网的原因、补安全恢复并重新发布 Mac 客户端。修改仅涉及 bootstrap、对应回归和 Mac 打包验收，不升级 Core，不发布 Windows，不更改桌面自动更新频道。

[根因与验证](../../../../bugs/2026/11/BUG-20261102-mac-offline-bootstrap.md)记录 pnpm 11.7.0 的并行供应链元数据请求，以及限定于已核验公司冻结锁的修复边界。已发布插件复用不可变归档，客户端使用独立新版本。

本轮核对了 bootstrap 的 601265aa、a7c17a9e、a5eeb80a 历史修复及旧回归。profile 锁、活动或未知进程保护、禁用插件、可选插件、用户依赖与失败材料均保留，没有功能删除或历史修复回退。已核主线包含 Windows 签名和覆盖验收修复，另有待审 Windows 在线升级 PR #278，本轮不接管。

本地定向测试、真实 pnpm 对照与 macOS 禁网安装/恢复通过。隔离源码 checkout 只读复用主环境工具；source-only fast 的 pnpm 启动门禁因本 checkout 未安装完整开发依赖而拒绝，改用相同脚本和已固定工具直接执行检查，正式候选仍须通过 hosted CI。

发布技能为本机 dsh-plugin-release 1.2.0，维护源未登记，状态 local_draft。未改团队规则或安装其他技能。合并、打包、发布读回与设备验收分别在 PR/Release 中记录，不从本地测试推定已发布。
