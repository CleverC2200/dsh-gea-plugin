<!-- collaboration-record
{"kind":"bug","id":"BUG-20260928-business-card-output","date":"2026-09-28","title":"业务概览仅返回文字且UI规则未启用工具","module":"业务Agent与展示","category":"功能逻辑","cause":"修复回退","severity":"P2","status":"已发布待验收"}
-->
# 业务卡片输出恢复

直接作答与仅交互才用组件的指令叠加，且直接读取UI Skill未同步启用展示工具。现按业务读取结果启用UI，成功Skill选择原子启用工具；明确纯文字的要求优先。

原生Harness覆盖按需启用、失败不授权、会话恢复及纯文字；两道真实模型问题出卡并经浏览器回放。候选GEA 0.0.135，发行证据在后续回执记录；不改变业务来源、单位或权限。

2026-09-28：GEA 0.0.135经MR !206、!207合并发布；四份频道和8个不同包地址匿名校验通过。发行回执：docs/releases/gea-0.0.135-verification.json。Windows实机更新与真实后端审批仍待验收。
