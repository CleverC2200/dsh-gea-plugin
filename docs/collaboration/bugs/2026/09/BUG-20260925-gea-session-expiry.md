<!-- collaboration-record
{
  "kind": "bug",
  "id": "BUG-20260925-gea-session-expiry",
  "date": "2026-09-25",
  "title": "网关业务会话过期后仍尝试取数且提示检查查询字段",
  "module": "GEA MCP 授权查询",
  "category": "功能逻辑",
  "cause": "原始遗漏",
  "severity": "P0",
  "status": "已修复待验证"
}
-->
# 网关业务会话过期后仍尝试取数且提示检查查询字段

- 发现时间 / 发现版本 / 影响范围：2026-09-25 同事在基地库存 Agent 对话中遇到；截图显示 `AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED`。客户端插件版本及生产部署 SHA 未由截图确认。
- 最小复现（脱敏 fixture）：授权资源发现返回 `success=false, code=AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED, category=SESSION`；或原生 MCP 工具返回同一业务失败信封，再尝试目录和下一模型查询。
- 预期 / 实际：应停止本轮旧会话取数，下轮按有效登录重新建会话并核对授权；原实现把错误归为普通下游失败，附“检查成员／measures”的错误建议，且未统一停住目录与查询入口。
- 已确认事实 / 未知项：客户端分类和停止缺口由源码与红绿测试确认；管理端为何使同事会话过期、其实际登录状态和部署版本仍未知。
- 根因与证据：`src/host/mcp-client.ts` 原失败分类没有 SESSION 分支；`src/host/agent-tools.ts` 原目录入口未对该错误设置整轮停止和缓存失效。
- 引入提交 / 修复提交 / MR / 关联记录：原问题出现于已发布的授权查询路径；准确引入提交待核对。修复候选位于本任务分支，未提交／未发布。
- 历史检查为什么未发现：原回归覆盖撤销授权和传输会话 404 恢复，缺业务 Session 最大生命周期业务信封和跨入口继续调用用例。
- 回归场景、命令、结果及源码 SHA：`node --test tests/authorized-cube-query.test.mjs tests/module-mcp.test.mjs` 已覆盖报错归类、停止、下一轮重建；候选基线 `930021dcb05c7f5ebd721e7f0a4c877f06360d4d`。
- 修复版本 / 发布证据 / 客户端或业务验收边界：未发布；同事原环境真实复测未做。
- 历史修复回退或删除是否涉及 / 用户具体确认凭据：无已确认旧修复回退或文件删除；维持公开 inspect 不可代替授权的原规则。

## 处理历史

| 日期 | 状态变化/复发 | 新增证据与关联提交 |
|---|---|---|
| 2026-09-25 | 首次记录，候选代码已通过定向检查，待安装验收 | 同事截图、授权资源/原生工具 fixture |
