# 桌面开发与历史验收入口

原长页是混合多个历史版本的记录，已在知识清单中登记为历史。原文保留于[主线提交 8c5716d](https://github.com/CleverC2200/dsh-gea-plugin/blob/8c5716d87deb9cf7bf77e50cf432d70dd1bf1573/desktop/README.md)，其中“当前 schema 为 1”、旧 Core、旧频道和原时间的完成状态不作为现行动作依据。

## 当前入口

- 源码开发与隔离输入见 [开发构建](../docs/development-builds.md)。
- 桌面打包、签名、在线更新与交付见 [桌面交付](../scripts/desktop-release.md)，三主插件接收见 [三包交付](../docs/package-delivery.md)。这些入口不授予发布权限。
- 数据 schema 读取 [desktop/package.json](package.json)，Core 身份读取 [当前登记](../scripts/current-core.json)及本次固定输入，更新来源读取 [发行来源配置](desktop-release-sources.json)，不在本文复写版本和默认值。
- 原唤醒范围与未完成真实飞书链路见 [NAVIGATION](NAVIGATION.md)。按其原输入解释，不由本次整理补记通过。

## 保留的保护和未完成验收

原记录中的数据、登录与失败恢复要求继续保留。配置、Session、工作区和凭据不进入版本目录或安装包。显式退出与凭据过期的处理按实际运行留证；无系统加密能力不降级到明文。

原 schema 不兼容时的拒绝准备、拒绝启动或降级、保留用户数据要求见[原数据保护章节](https://github.com/CleverC2200/dsh-gea-plugin/blob/8c5716d87deb9cf7bf77e50cf432d70dd1bf1573/desktop/README.md#L68)。标记旧 schema 为历史不代表已实现跨 schema 迁移，不通过删除用户数据解决兼容问题。当前兼容行为须核实际源码与本次输入。

以下原验收边界仍需对应证据，本文不把它们改为通过：

- Windows 真机的更新、失败恢复、重试、系统加密身份和数据保留。
- 新桌面壳、协议唤醒与真实飞书链路的独立验收。
- 签名、公证、时间戳、Gatekeeper 及新机器通过实际下载首次打开的验证。临时签名、本机直接启动和源码 CI 不能互相替代，不关闭系统保护来绕过。
- 首次下载、普通安装、重启和在线更新完整界面流程。固定夹具、构建成功和历史发行均不补齐原未完成设备验收。
- 公司网络下载与公共 CI 的本地归档安装分别留证；`local-verified-archive` 不证明完成内网下载。原性能计时只适用于原平台与输入，不作为 Windows 实测或性能保证。
- 原安装与存储候选的实施和未完成条件见 [实施记录](../docs/desktop-install-storage-implementation-20260927.md)。自签名测试证书不用于正式发布，MSIX 试验不视为正式频道接收；公开证书与本地信任身份不能由远端清单替换。

版本与缓存回收的原保护继续保留：当前、上一套可用、待重启、固定、手动及迁移引用不按普通旧版本删除，未知 staging 和损坏收据保留。发行来源与跨源镜像仍须核实际清单、固定字节和摘要，不通过放宽校验解决旧链接失效。

[原始失败、恢复和安装限制](https://github.com/CleverC2200/dsh-gea-plugin/blob/8c5716d87deb9cf7bf77e50cf432d70dd1bf1573/desktop/README.md)按原时间和输入追溯。当前未完成业务与交付风险见 [文档索引](../docs/index.md)，不因历史入口退场关闭。
