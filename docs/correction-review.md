# 纠偏功能交付审查记录

结论：本地客户端及 DMS mock 范围实现完成，无未解决的已确认审查问题。真实 GEA 部署与联调尚未验证，不能据此宣称生产验收完成。

风险等级：高（审批写入、版本重提和共享接口契约）。

## 范围

- 仓库：`/Users/synear/Documents/ChatGPT/dsh-gea-plugin`；分支：`codex/gea-save-guard`。
- 基线及 merge-base：`b46dc42fe509be9cd703ee842a7994e7f7087c10`。
- 实现提交：`f5456c3e6de83e495e6b494bc1252f0030ce5695`；修复后代码提交：`2a31c83b89f7e0e606b446de269ccb2458df2739`。
- 差异命令：`git diff b46dc42fe509be9cd703ee842a7994e7f7087c10...2a31c83b89f7e0e606b446de269ccb2458df2739`。代码提交后工作区干净，本记录及验收结果随后单独归档。
- 意图来源：规格 #26、任务 #27–#33、`specs/sales-plan-correction.md` 以及用户确认的绝对净调整、SAVE 仅保存 adj、先用 DMS mock。
- CodeGraph 已初始化；最终 `codegraph status /Users/synear/Documents/ChatGPT/dsh-gea-plugin` 确认索引最新。

## Standards

初审发现 1 项 P2：Host 纠偏校验使用默认流程，可能拒绝环境新增的审批类型，与实时配置约定不符。现已读取当前环境 workflowConfig，并向准入、动作和继承模型显式传参；重提路径同样传参。新增 NEW 类型的 Host HTTP 集成测试通过。原审查代理复核未发现该问题残余，未重复运行测试。

## Spec

初审发现 1 项 P1：基准数量 0、继承 +8 后编辑为 0，请求遗漏零决定导致 Host 再次继承 +8。现请求保留显式零，服务端验证后再跳过双零行存储，回读验证支持该删除结果。规则回归通过；原审查代理复现该场景，确认页面与 Host 一致，SAVE/APPROVE 回读校验通过。

Standards：1 项已修复，剩余 0；Spec：1 项已修复，剩余 0。

## 覆盖台账

下列 23 个改动路径已完成审查；没有未处理的可审查路径。独立双轴初审针对实现提交，随后针对修复差异复核。

| 分类 | 路径（相对仓库） | 处置与依据 |
| --- | --- | --- |
| 配置 | `.gitignore` | reviewed：仅隔离索引和临时产物 |
| 文档 | `README.md`、`docs/agents/issue-tracker.md`、`docs/correction-acceptance.md`、`docs/sales-plan-client-approval-correction-research-2026-09-13.md`、`specs/sales-plan-correction.md` | reviewed：需求追踪、确认口径和真实环境边界 |
| Host | `src/business.ts` | reviewed：身份、快照、幂等重试、动态流程、重提原值核验；HTTP 边界测试 |
| 契约 | `src/workbench-original/contracts.ts` | reviewed：可选新增字段、显式纠偏模式与 mock 来源 |
| 文案 | `src/workbench-original/en-US.json`、`src/workbench-original/zh-CN.json` | reviewed：纠偏入口和反馈文案 |
| UI | `src/workbench-original/workbenches/regionalApproval/CorrectionWorkbench.tsx`、`CorrectionWorkbench.module.css`、`RegionalApprovalWorkbench.tsx`、`RegionalApprovalResubmitDialog.tsx`（后三者同目录） | reviewed：查询切换、权限、重复操作、继承、回读和模态窗口；实际浏览器测试及截图 |
| 规则 | `src/workbench-original/workbenches/regionalApproval/models/salesPlanActionModel.ts`、`salesPlanCorrectionModel.ts`、`salesPlanSubmitModel.ts`（后两者同目录） | reviewed：精度、绝对覆盖、零值、状态及新版本字段；规则和浏览器验证 |
| 测试 | `tests/correction-host.test.mjs`、`tests/correction-resubmit-web.test.mjs`、`tests/correction-rules.test.mjs`、`tests/correction-web.test.mjs`、`tests/fixtures/correction-service.mjs`、`tests/resubmit.test.mjs` | reviewed：实际 Web/Host 入口，外部受控服务与独立回读；保留既有测试 |

生成产物 `.codegraph/`、`.runtime/` 和临时 `.scratch/` 不进入代码交付；索引与合成样本截图仅作为本地辅助证据。没有依赖版本变更、测试删除或跳过新增。

## 验证与证据

| 层级 | 验证 | 结果 |
| --- | --- | --- |
| local | `rtk proxy npm run typecheck` | 通过 |
| local | `rtk proxy npm run build` | 通过 |
| local / runtime/browser | `rtk proxy node --test --test-concurrency=2 tests/*.test.mjs scripts/gea-error.test.mjs` | 107/107 通过，0 失败/跳过/取消，约 92 秒 |
| local | `rtk proxy git diff --check` | 通过 |
| runtime/browser | 真正 DSH Web profile → UI → Host → 外部受控 GEA HTTP fixture → 独立回读 | 保存、继承通过、退回、重提、DMS mock 部分接收及对账到 10；既有 M 保存回归通过 |
| runtime/browser | `.runtime/correction-evidence/detail.png` | 合成样本截图已检查，明细表在模态框内横向滚动 |
| external/production | 真实 GEA 纠偏写入、正式 DMS | 未执行；不是以上测试的覆盖范围 |

## 待办与阻断原因

客户端和 mock 开发任务均已执行。真实 GEA 联调待其部署 `absolute-net-v1` 适配字段、事务/授权规则及可用测试权限；当前证据仅来自受控 HTTP 服务，不能替代真实接口验收。正式 DMS 按用户要求暂用 mock，不阻断本轮客户端开发。契约和上线前条件详见 `correction-acceptance.md`。
