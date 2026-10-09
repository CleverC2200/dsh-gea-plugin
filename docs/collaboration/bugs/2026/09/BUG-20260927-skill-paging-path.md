<!-- collaboration-record
{"kind": "bug", "id": "BUG-20260927-skill-paging-path", "date": "2026-09-27", "title": "全链库存问答把分页参数写进Skill路径", "module": "业务Agent与Skill", "category": "功能逻辑", "cause": "原始遗漏", "severity": "P2", "status": "已发布待验收"}
-->
# Skill分页参数误填

- 用户询问页面推荐问题“基地到分仓的库存怎么走？”，模型传入 `{"name":"inventory-qll","path":"offset 1, limit 80, reload=true"}`，触发 `GEA_SKILL_REFERENCE_NOT_LINKED`。同事实际插件版本待确认。
- 最小复现调用真实 gea_skill 实现；旧代码确定失败。修复只将完整且无歧义的 offset/limit/reload 字符串恢复为独立参数，并返回 argumentCorrection。冲突、越界、未链接路径与URI仍拒绝。
- 参数说明补充正文重读示例，非法路径给出可纠正提示。全链推荐问题默认先说明一般流转过程；具体分布、在途、调拨按最小证据查询，静态快照不推断实际流向。
- 保留 Skill 可见范围、授权、分页范围、重复正文识别与工具预算。未删文件或旧回归；不是权限放宽。
- `tests/skill-argument-recovery.test.mjs` 覆盖原截图、分页恢复、冲突及路径拒绝；`tests/prompt-runtime.test.mjs` 通过原生Harness验证同一句问题及错误工具参数可完成回合。
- 引入提交及模型为何生成该参数尚未确定。修复候选0.0.130；实际同事账号复测待做，模拟模型不等于真实模型完成业务验收。

2026-09-27：GEA 0.0.130经MR !190合入并发布。源码3d0e2b409c04ccb9bd77ae99b792bae351b7abfb，四份GitLab/OSS测试及正式清单和八个包下载地址均验证通过。实际同事账号问答待验收。
