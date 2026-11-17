<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261117-environment-isolation","date":"2026-11-17","title":"登录环境与能力目标隔离发布","module":"身份与业务接口","status":"已发布"}
-->
# 登录环境与能力目标隔离

本轮按用户批准方案统一 GEA 请求出口。业务和 DMS 跟随登录环境，预警按环境读取显式部署，共享记忆允许使用同一服务且保留环境、租户和用户归属。切换身份后拒收旧响应，错误目标在发出请求前阻断。接口日志分别保留登录环境和实际请求来源，元数据模式继续保护报文与凭据。

截图中的 `gea.synear.cn:4443` 预警轮询地址本身不能证明测试环境。已确认的问题是能力自行选择目标、DMS 历史共享测试默认及日志缺少实际来源，详见 [环境目标分散记录](../../../../bugs/2026/11/BUG-20261117-environment-target-divergence.md)。服务器反向代理和最终数据源未检查。

## 源码与发布

| 组件 | 版本 | 固定源码 | 本轮交付 |
|---|---|---|---|
| GEA | 0.0.304 | `6c73a7bb91ad5801103c6cde0b3e716677f39dda` | 新归档 |
| Workbench | 0.1.125 | `54afeb0416bb430f60921a024d1e51e8ee30e8ac` | 复用已发布原字节，包含环境日志修复 |
| Manage | 0.6.3-company.80 | `797e4c480bf2ebb05b7ccc6ede82594dde324216` | 复用已发布原字节 |

[GEA PR #431](https://github.com/CleverC2200/dsh-gea-plugin/pull/431) 与 [Workbench PR #355](https://github.com/CleverC2200/dsh-agent-workbench/pull/355) 已合并。[GEA Release](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.304) 保存固定下载地址、大小和摘要；[Workbench Release](https://github.com/CleverC2200/dsh-agent-workbench/releases/tag/v0.1.125) 和 [Manage Release](https://github.com/CleverC2200/dsh-agent-manage/releases/tag/v0.6.3-company.80) 已核验。

2026-11-17 测试频道 revision 135、正式频道 revision 127 已发布。使用生产 `createPluginReleaseSource` 匿名读取两频道，并分别完整下载三包，版本、大小与 SHA-256 均与正式归档一致。三包摘要如下。

| 组件 | SHA-256 |
|---|---|
| GEA | `66aeb0ba6917d4fd52b47a170b72a9097e31d897878ed3eb02ff32c3eeeef5eb` |
| Workbench | `47db1e10215ad8baa358696fcc0b73c343d2e77d842a7c6772c03a31942fff7b` |
| Manage | `2803ac60e599af2aab4e93eacc6057462627439a5b34698d217be6be4f4b200b` |

## 验证与边界

- [最终固定组合完整 CI](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/44016084233) 的 16 项任务全部通过，包含 GitHub Windows、macOS 及运行时分片；[正式构建、发布预检与官方安装接收](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/44016325025) 通过。
- 实际验收 Core 为 `8cc49e9b5c5ddf3751af2f6fb21276513a14bf9b`。Mac 使用实际桌面宿主与独立配置安装最终归档，六个入口与归档字节一致，安装、Host、client 版本一致，未登录状态下测试和正式切换通过，页面无错误。未修改用户正式配置、凭据、会话或草稿。
- 个人 Windows 设备按用户要求另列，尚未验收。真实生产业务、服务器代理和预警/记忆服务部署未验收。插件发行不包含桌面安装包。
- 本轮修复环境路径冲突、Linux Documents 准备、工作进程准备计时和取消计时混用等测试夹具问题。准备阶段可等待 30 秒，取消后退出要求仍为 5 秒。历史失败证据保留。
- 已同步金额、DMS、预警 V0.6 及后续已发布同事修复。早期候选与 Workbench 124 未由本任务发布，最终组合保留当前已发布 125/80。历史 DMS 共享测试默认按本轮明确批准方案退场，不迁移或清空用户数据。
- 发布技能为本机 dsh-plugin-release 1.3.2 `local_draft`，未声称团队技能已同步。现有人工索引保留，仅补本轮入口。
