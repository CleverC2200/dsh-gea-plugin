<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261028-remove-channel-signature","date":"2026-10-28","title":"移除插件频道签名要求","module":"插件更新","status":"待合并"}
-->

# 移除插件频道签名要求

按用户明确要求，取消 GEA 更新频道的发布者签名校验与 keyId、公钥、私钥配置。发布工具改用 encodePluginChannel 生成 payloadBase64 envelope。新版 GEA 忽略旧配置和 envelope 的签名字段，保留现有传输结构及原用户回执。

HTTPS 来源限制、release/TGZ 摘要、归档及 manifest 检查、revision/有效期、版本高水位、完整组合兼容和安装恢复规则继续执行。控制 OSS 写入权限的人可以发布可接受的新清单，摘要不再提供发布者身份认证。

本次只提交源码与操作说明，不发布插件或桌面包，不改线上频道和现装客户端。旧 GEA 仍需通过原签名流程获得一次过渡更新，安装并重启后才能使用无签名频道；迁移期间保留旧客户端可用入口。

本地来源、归档、组合、预检和桌面输入共52项检查通过；10个变更代码/测试文件的仓库 lint 和格式检查通过。PR 的必需 CI 与合并状态以对应 GitHub 回执为准。真实设备更新、Native 和业务验收未执行。
