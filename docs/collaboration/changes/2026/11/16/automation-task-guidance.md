<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261116-gea-automation-guidance","date":"2026-11-16","title":"自动化任务对话创建引导与居中提示","module":"自动化任务","status":"已发布，完整升级验收待补"}
-->

# 自动化任务对话创建引导与居中提示

采用公司 Core [#30](https://github.com/CleverC2200/deepseek-harness/pull/30)，固定提交 `8cc49e9b5c5ddf3751af2f6fb21276513a14bf9b`。点击“新建”沿用原有对话入口，显示任务内容和执行时间示例，提示约 10 秒。提示等待对话输入区挂载后与其居中对齐。此次不新增创建表单或后端接口，保留任务删除提示与用户数据。

现有 GEA 开发客户端已实际验证，用户确认可以发布。ui-schedule 原有 773 项测试通过，对齐回归所在文件 7 项通过；完整 Host/Client 类型检查、静态检查与翻译配对通过。doc-sync 41 项通过，生成目录及私有验收文件导致的两项失败已修正并分别重跑通过。

Mac arm64 与 Windows x64 均已发布正式安装包和在线更新源，版本为 `0.2.0-rc.2.20261116.1`。发行源码固定为 `a0d77eb2a84f7284c56fd8e6ef23635bba894cac`，由 [GEA #419](https://github.com/CleverC2200/dsh-gea-plugin/pull/419) 合入，[合并后 CI](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43824032320) 通过。本记录的后续更新不改变发行源码或标签。

配套包复用 Workbench 0.1.116、Manage 0.6.3-company.76、GEA 0.0.294 及个人记忆 0.1.2；原归档字节保留，兼容元数据追加本次 Core。stable revision 119、test revision 127 已发布，匿名下载、摘要与新旧 Core 组合校验通过。固定下载、源码和各平台文件摘要见 [GitHub 发行记录](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/desktop-v0.2.0-rc.2.20261116.1)及其中的发行清单。

Windows [签名构建任务](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43824966690/job/133156512388)通过，安装、运行时和隔离签名升级测试通过。父工作流因独立的 Mac 子任务缺签名输入而失败，Mac 改用[独立构建](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43826210619)，签名、公证、安装和运行时检查通过。两端更新载荷、安装包与清单均通过匿名完整读回核验。

本版双端旧客户端真实界面下载、原生自动重启、原账号恢复及配置和非空历史保留仍待验收，状态为 `pending-full-ui-regression`。本机正式 Mac 尚未升级，Windows 员工设备未验收，不能将隔离安装和脚本检查视为完整更新回归。

[本版更新说明](https://klvcodtump.feishu.cn/docx/IQstdOX4RoDOmVxtqEWcJ0bjnFh)已生成，[固定安装指南](https://klvcodtump.feishu.cn/docx/W85mdQbvhokGkIxPm1vcNUICn2T)已同步两个平台的下载链接。仅替换下载段落，其他内容与图片保留。

发布流程使用本机 dsh-plugin-release 1.3.2 local_draft，未登记团队维护源；使用已登记 GitHub 与 OSS，不写旧 GitLab。

新 Core 仅改变界面和生成目录，沿用已登记的原生工具集合。独立目录场景夹具追加该提交的明确预期，保留未知 Core 拒绝校验；本地目录输入回归 5 项通过，合并后完整 CI 通过。Ubuntu 镜像连接失败保留原日志；现有 HTTPS 镜像更新失败时改用 Ubuntu 官方 HTTPS 归档重试，继续要求签名索引完整通过，不修改业务或跳过必需 CI。
