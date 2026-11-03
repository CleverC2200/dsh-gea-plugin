<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261103-order-kpi-skills-release","date":"2026-11-03","title":"订单 KPI 技能及卡片明细联动三插件发布","module":"订单工作台","status":"已发布"}
-->

# 订单 KPI 技能及卡片明细联动发布

本轮已发布 Workbench 0.1.51、Manage 0.6.3-company.47、GEA 0.0.216。线上基准分别为 0.1.50、0.6.3-company.46、0.0.215；已发布版本的归档保持不变，仅从合并后的固定源码构建新版本。

Workbench [PR #208](https://github.com/CleverC2200/dsh-agent-workbench/pull/208) 将六张指标卡连接到页面关联的真实 Session，发送带有本期及本周边界的明细请求，并在成功后显示右侧 Agent。Manage [PR #116](https://github.com/CleverC2200/dsh-agent-manage/pull/116) 更新 KPI 分析技能并新增指标明细技能。GEA [PR #288](https://github.com/CleverC2200/dsh-gea-plugin/pull/288) 登记新技能，保持原 Consumer、数据及写权限边界。

已定位并修复新技能未登记导致的装载拒绝、Core remote 缺少显式注入导致的卡片发送失败；旧测试的技能数量及冻结配套输入已同步。上述 PR 的必需 CI 均已通过并合并。本地实际点击满足率卡片后，Agent 成功加载新技能并查询生成明细表。有限明细样本仍不得冒充完整清单。

本次版本准备只调整版本、编译标识、Workbench 锁中的根版本，以及 GEA 对两个新版配套插件的兼容声明。没有移除文件、公共接口或历史回归断言；本地其他未提交取数修改不属于发布输入。已读取当前主线的相关协作记录；仓内没有独立 Bug 索引，本轮问题沿上述修复 PR 留证，不制造重复 Bug。

发布技能使用用户提供的 dsh-plugin-release 1.2.0 distributed_bundle，完整文件摘要已核验；未登记团队维护仓，不宣称已同步技能到团队。已完成合并后固定源码构建、三包交付、正式预检、隔离环境官方安装和 Host/资源接收，以及两个频道的生产读取器实际下载校验。

本次只发布三个插件，不包含桌面安装包、Core 升级或新增业务授权。Native、用户设备升级及指标与业务报表的最终一致性不属于本轮发布验收。

## 最终发布记录（2026-11-03）

测试频道 revision 72、正式频道 revision 64，均包含完整三包组合。上传后匿名读回的 TGZ 与 release JSON 摘要均一致；生产读取器从两个频道分别完成检查、下载及归档身份校验。

| 插件 | 版本与发行页 | 固定源码 | TGZ SHA-256 |
| --- | --- | --- | --- |
| dsh-agent-workbench | [0.1.51](https://github.com/CleverC2200/dsh-agent-workbench/releases/tag/v0.1.51) | `139aefe673b8ebfef6124b0dd3aa6df205b4f59b` | `adc8d04e080015e8fc61299e80e6c5f514481e91af273b01dd3a28c75ecd3bbc` |
| dsh-agent-manage | [0.6.3-company.47](https://github.com/CleverC2200/dsh-agent-manage/releases/tag/v0.6.3-company.47) | `3afb4fae59d0db60f31290333fac8fa87da09626` | `de5afbeffdeadd12bdc63b59fb615956d4ab066b121505e357b4b7f80aab373d` |
| dsh-gea-plugin | [0.0.216](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.216) | `e3a2747902a15ab9f820ee05c12677bd78f64cef` | `27ba6ae8b27f9d8e2941cb8223120bfc515368c953d38a0059bf69b69c2a1915` |

版本准备 PR：[Workbench #210](https://github.com/CleverC2200/dsh-agent-workbench/pull/210)、[Manage #117](https://github.com/CleverC2200/dsh-agent-manage/pull/117)、[GEA #290](https://github.com/CleverC2200/dsh-gea-plugin/pull/290)，均以 main 为目标，必需 CI 通过并合并。GEA 最终汇总首次因 GitHub 作业状态传播延迟拒绝成功分片；核对全部成功 producer 后，仅重跑该汇总，原 run 第二轮通过，未改业务代码或重跑整套测试。

相对上一已发布版本，GEA 还包含 [PR #286](https://github.com/CleverC2200/dsh-gea-plugin/pull/286) 的员工登录重提迁移，删除旧 `src/host/service-account.ts` 与 `tests/service-account.test.mjs`，由当前员工身份调用重提接口；来源、角色、数量范围、幂等及身份取消检查保留。现有执行文档注明服务端目标计划数据范围校验尚未补齐，客户端检查不能替代该约束。发布前已单独向用户披露并获得对这项迁移、删除和限制的明确发布确认；不将其记录为已完成服务端业务验收。

接收使用已登记 Core `a0c0d2ff884b1808eccb9bb254a1659281364d7d`（0.2.0-rc.2）。隔离 profile 三包安装、Host 装载、资源及预设检查通过；未读取或复制业务凭据，模型任务和业务查询均为 0。Native、真实用户升级和业务写入仍未验证。源码、发布说明和包均不包含 OSS 凭据。
