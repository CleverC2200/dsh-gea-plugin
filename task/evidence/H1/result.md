# H1 Host 纠偏合同证据

状态为待集成审查，2026-10-19。仅使用本任务独立 checkout、Business 公开读写入口与外部 HTTP 替身；真实审批和 DMS 调用数为 0。

## 输入与修改

- GEA 起点 `89c17ecfd27d3cb94f3c7bc8876629fe1ca651c8`，分支 `codex/sales-plan-correction-h1-20261019`。
- 私有 Workbench peer 起点 `39204b03d5981974e8647b233e763ac20dc3de76`；能力修复后 fast-forward 至 `bceb0ffbdca8d099e4cb127ef8edfe2b55de6202`。此依赖必须随本票集成，不能只合入 Host 透传改动。
- 固定 SDK 为 `/Users/synear/Documents/Codex/2026-10-11/task-2/jobs/rc2/official-latest-standard`，来自主线程登记输入；仅只读引用。Manage 为本任务固定 `a6fc5793206e626956f6b4a0febacb52af1a853d`。
- Node `v24.14.1`、pnpm `11.27.0`。沿仓内“准备依赖”Action 使用 `--frozen-lockfile --prefer-offline`，本仓独立 node_modules，未共享其他工作树可写目录。

`SalesPlanTransactions` 向后端补齐 `ABSOLUTE_NET`、`expectedSnapshot`、`approvalRole`。省略角色的既有纠偏请求绑定本次已校验的唯一角色；结果未知后仍重放原键原正文。普通 M 角色合同保留。明细六字段、冻结金额和列表进度/summary 已有原样透传，新增公开入口实测，没有复制业务计算。

交接文档已更新当前隔离后端授权与真实 camelCase REST 合同，旧 MR !116 保留为历史。

## 红绿与检查

| 证据                                                        | 结果                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-preparation-failure.log`                                | 首次测试未启动业务断言，私有 Workbench peer 的 external decimal.js 无依赖解析；不计作业务红灯                                                                                 |
| `02-save-transport-red.log` → `03-save-transport-green.log` | 先证明后端请求丢失模式、快照及角色，再补齐透传通过                                                                                                                            |
| `04-node-role-red.log` → `05-node-role-green.log`           | 先证明省略角色时未发节点身份，再绑定已验证角色通过                                                                                                                            |
| `07-capability-red.log` → `12-public-host-green.log`        | 先证明 `approvalOpen=false` 仍可能写入；消费 W1 独立能力修复后拒绝窗口关闭、缺能力、错误节点、空 actions 和同提报账号                                                         |
| `12-public-host-green.log`                                  | `node --test tests/sales-plan-action.test.mjs`，15/15 通过；含 8 条原 M/身份/幂等回归，7 条纠偏和读回用例                                                                     |
| `13-host-types-final.log`                                   | `node node_modules/typescript/bin/tsc -p .runtime/h1-types.json`，退出 0；config 继承 `tsconfig.official.json`，include 仅 `src/host/sales-plan-transactions.ts` 及其真实依赖 |
| `09-source-checks-initial.log`                              | 初次 lint 通过，测试及文档格式失败，已由仓内 oxfmt 修正；原失败保留                                                                                                           |
| `14-source-checks-final.log`                                | `quality:fast --source-only` 对三个改动文件执行，lint、格式、知识入口、Prompt owner、环境回归与发行合同均通过                                                                 |

Workbench 私有 peer 只定向编译 `src/sales-plan.ts` 到该 peer 的 `lib/sales-plan.js`，使用本仓 esbuild 及 nodePaths 解析并 bundle decimal.js。未全构建 peer、未复制依赖；生成物只供本次公开入口测试。

## 未完成范围

本结果不代表真实 Core profile、浏览器用户路径、已部署后端、真实发货数据、审批或 DMS 验收；未安装、发布、推送。W1 最终金额/六字段模型与 B1 后端实现仍由各自票负责，主线程合并后按实际输入选择组合检查。H1 需完成集成及最终审查后才能标 done。
