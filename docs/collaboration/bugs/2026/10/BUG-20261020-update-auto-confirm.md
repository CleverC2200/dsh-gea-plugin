<!-- collaboration-record
{"kind":"bug","id":"BUG-20261020-update-auto-confirm","date":"2026-10-20","title":"Host 迟到导致重启后自动确认停止","module":"插件更新","category":"功能逻辑","cause":"原始遗漏","severity":"P2","status":"已验证待发布"}
-->

# Host 迟到导致重启后自动确认停止

启动恢复原先连续三次状态读取失败便停止。脱敏回归令 Host 前四次返回未就绪，原实现无法继续自动确认；实际 Native06 也曾在打开详情前等待超时。

启动在既有120秒恢复窗口内继续重试，成功读取即结束该恢复窗口；后续沿原观察窗口等待真实 Loader、Host/client 和 nonce 证明，不重新提交安装。

修复已通过 [PR120](https://github.com/CleverC2200/dsh-gea-plugin/pull/120) 合并至 `bd525288fa32829f50fcbf735c05c2b610621e48`。本地187项更新及CI影响回归通过，[CI39354346856](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/39354346856) 21个适用job成功。合并源码在macOS arm64隔离客户端真实更新Manage、官方重启，详情及手动观察前自动completed，12项Agent、Skill、配置、Session和草稿检查通过。

计划随GEA0.0.176发布。正式包与频道尚待读回，日常客户端不在本次操作范围；Windows桌面UI未验。没有删除功能、测试或历史修复。
