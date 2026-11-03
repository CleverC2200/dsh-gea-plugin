<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261103-order-kpi-skills-release","date":"2026-11-03","title":"订单 KPI 技能及卡片明细联动三插件发布","module":"订单工作台","status":"待发布"}
-->

# 订单 KPI 技能及卡片明细联动发布

本轮目标为 Workbench 0.1.51、Manage 0.6.3-company.47、GEA 0.0.216。线上基准分别为 0.1.50、0.6.3-company.46、0.0.215；已发布版本的归档保持不变，仅从合并后的固定源码构建新版本。

Workbench [PR #208](https://github.com/CleverC2200/dsh-agent-workbench/pull/208) 将六张指标卡连接到页面关联的真实 Session，发送带有本期及本周边界的明细请求，并在成功后显示右侧 Agent。Manage [PR #116](https://github.com/CleverC2200/dsh-agent-manage/pull/116) 更新 KPI 分析技能并新增指标明细技能。GEA [PR #288](https://github.com/CleverC2200/dsh-gea-plugin/pull/288) 登记新技能，保持原 Consumer、数据及写权限边界。

已定位并修复新技能未登记导致的装载拒绝、Core remote 缺少显式注入导致的卡片发送失败；旧测试的技能数量及冻结配套输入已同步。上述 PR 的必需 CI 均已通过并合并。本地实际点击满足率卡片后，Agent 成功加载新技能并查询生成明细表。有限明细样本仍不得冒充完整清单。

本次版本准备只调整版本、编译标识、Workbench 锁中的根版本，以及 GEA 对两个新版配套插件的兼容声明。没有移除文件、公共接口或历史回归断言；本地其他未提交取数修改不属于发布输入。已读取当前主线的相关协作记录；仓内没有独立 Bug 索引，本轮问题沿上述修复 PR 留证，不制造重复 Bug。

发布技能使用用户提供的 dsh-plugin-release 1.2.0 distributed_bundle，完整文件摘要已核验；未登记团队维护仓，不宣称已同步技能到团队。正式发布还需固定源码构建、三包交付、预检、实际来源下载及安装接收。频道和 GitHub Release 在本页提交时尚未发布，最终版本、标签、摘要和验收结果由本轮发行回执及 GitHub Release 记录。

本次只发布三个插件，不包含桌面安装包、Core 升级或新增业务授权。Native、用户设备升级及指标与业务报表的最终一致性不属于本轮发布验收。
