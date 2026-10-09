<!-- collaboration-record
{"kind":"change","id":"CHANGE-20260928-gea-hide-preview-agents","date":"2026-09-28","title":"隐藏三个演示 Agent 并保留业务页面","module":"Agent 预设","status":"已发布待验收"}
-->
# 隐藏三个演示 Agent 并保留业务页面

0.0.132 恢复预览页面时，将客户库存、订单履约、订单工作台也重新放进了 Agent 下拉框。本次隐藏这三个独立 Agent，业务页面继续显示，并绑定现有默认助手。

- 主线基线：`114ae9c86054238c2d0622d557a4ecc764bbcc28`；引入提交：`2a4dfc7bbf9a25f12b6f840f770dac0ead9e05e9`。
- 修复：将页面下架状态与预设可见性分离，清理旧版本遗留的三个预设目录，真实业务 Agent 保持原顺序。
- 历史修复审查：保留 0.0.125 的演示 Agent 隐藏规则，并保留 0.0.132 恢复的页面；未删除业务页面、接口、依赖或测试。
- 用户明确要求隐藏这三个入口，并在看到修复结果后授权提交 MR 及合并；不包含发行包或更新频道变更。
- 验证：`node --test tests/html-page-tool.test.mjs tests/html-client-pages.test.mjs tests/html-plugin-selection.test.mjs tests/preset-modes.test.mjs`，23 项通过；`pnpm run typecheck` 与 `node scripts/build.mjs --target host,client` 通过；冻结依赖安装成功，锁文件未改变。
- 边界：尚未发布、尚未进行真实客户端界面及旧预设历史会话恢复验收；用户会话数据不作迁移或删除。
- 关联问题：[Agent 列表演示入口复发](../../../../bugs/2026/09/BUG-20260924-gea-agent-picker.md)。
- 团队记录核对范围：本模块既有 Bug 卡及最近更新索引；本次按原问题追加复发记录，未新建重复 Bug。

2026-09-28：按用户明确要求随GEA 0.0.134发布，合并来源MR !201；页面仍保留。频道及包验证见 docs/releases/gea-0.0.134-verification.json，真实客户端验收待进行。
