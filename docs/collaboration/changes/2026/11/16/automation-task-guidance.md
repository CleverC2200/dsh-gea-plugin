<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261116-gea-automation-guidance","date":"2026-11-16","title":"自动化任务对话创建引导与居中提示","module":"自动化任务","status":"构建待发布"}
-->

# 自动化任务对话创建引导与居中提示

采用公司 Core [#30](https://github.com/CleverC2200/deepseek-harness/pull/30)，固定提交 `8cc49e9b5c5ddf3751af2f6fb21276513a14bf9b`。点击“新建”沿用原有对话入口，显示任务内容和执行时间示例，提示约 10 秒。提示等待对话输入区挂载后与其居中对齐。此次不新增创建表单或后端接口，保留任务删除提示与用户数据。

现有 GEA 开发客户端已实际验证，用户确认可以发布。ui-schedule 原有 773 项测试通过，对齐回归所在文件 7 项通过；完整 Host/Client 类型检查、静态检查与翻译配对通过。doc-sync 41 项通过，生成目录及私有验收文件导致的两项失败已修正并分别重跑通过。

桌面构建目标为 Mac arm64 与 Windows x64。配套包复用正式频道已发布的 Workbench 0.1.116、Manage 0.6.3-company.76、GEA 0.0.294 及个人记忆 0.1.2；原归档字节保留，兼容元数据追加本次 Core。正式版本、下载与安装验收在发行回执补充，当前尚未发布。

发布流程使用本机 dsh-plugin-release 1.3.2 local_draft，未登记团队维护源；使用已登记 GitHub 与 OSS，不写旧 GitLab。

新 Core 仅改变界面和生成目录，沿用已登记的原生工具集合。独立目录场景夹具追加该提交的明确预期，保留未知 Core 拒绝校验；本地目录输入回归 5 项通过，远端完整业务回归继续验证。Ubuntu 镜像连接失败保留原日志；现有 HTTPS 镜像更新失败时改用 Ubuntu 官方 HTTPS 归档重试，继续要求签名索引完整通过，不修改业务或跳过必需 CI。
