<!-- collaboration-record
{"kind":"bug","id":"BUG-20261020-agent-update-preservation","date":"2026-10-20","title":"更新缺少用户 Agent 与完整 Skill 保全核验","module":"插件更新","category":"功能逻辑","cause":"原始遗漏","severity":"P2","status":"已验证待发布"}
-->

# 更新缺少用户 Agent 与完整 Skill 保全核验

安装事务原先只备份安装图，没有独立保全 agent-plugins 用户目录。新增回归在原实现因缺少用户数据备份失败。这证明保护与验收缺口，不代表已经观察到真实用户数据丢失。

安装前复制并验证完整用户目录；安装结束及新进程完成前核原文件和配置仍保留。异常保留 unknown、当前值和恢复副本，不自动覆盖并发用户修改。

修复已通过 [PR120](https://github.com/CleverC2200/dsh-gea-plugin/pull/120) 合并至 `bd525288fa32829f50fcbf735c05c2b610621e48`。本地187项更新及CI影响回归通过，[CI39354346856](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/39354346856) 21个适用job成功。合并源码在macOS arm64隔离客户端真实更新Manage、官方重启，详情及手动观察前自动completed，12项Agent、Skill、配置、Session和草稿检查通过。

计划随GEA0.0.176发布。正式包与频道尚待读回，日常客户端不在本次操作范围；Windows桌面UI未验。没有删除功能、测试或历史修复。
