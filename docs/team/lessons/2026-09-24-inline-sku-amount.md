# 确认计划量变化但同一 SKU 的明细金额不变

- 状态：**待修复**。本次只诊断与建立协作机制，没有修复业务代码。
- 分类：原始遗漏；未发现修复后被覆盖的证据。
- 引入提交：`a7b0bae6a192b4c6219d5ffb511c546fdfc90386`，2026-09-18，`fix: inline sales plan quantity editing`。Git 作者/提交者为 synear；实际人工或 Agent 操作者未知。
- 复现：SKU 数量 20、单价 10、金额 200；调用行内编辑的真实 onChange 将数量改为 22，重新渲染后金额仍为 200，预期 220。
- 证据：`src/workbench/original/workbenches/regionalApproval/InlineSkuDetails.tsx` 的输入写入 `confirmedValues`，金额格直接渲染 `formatExactDecimal(sku.amt)`；`confirmedMetrics` 虽计算数量乘单价，未用于此格。
- 历史对比：引入提交前无行内输入；引入提交、`b15b85f`、`c678ca3`、主线 `11412c7783e2c8438a4db6c4a0e36d39cb89d1e6` 的组件级临时 harness 均复现。harness 使用简化 hooks 和模拟 SKU，未连接业务系统；临时内存替换金额表达式后得到 220。临时 harness 不是持久回归测试，也不是修复完成证明。
- 漏检：`tests/v16-web.test.mjs` 检查数量和汇总金额变化，没有检查同一 SKU 的明细金额格。
- 防复发：修复时先补能失败的同一行金额浏览器断言，再核对汇总、草稿恢复和节点口径；使用项目精确小数方法。不要只匹配源码字符串或只测汇总。
- 修复提交/MR：未产生。
- 未核验：截图客户端具体版本、保存后服务端金额及真实业务结果。不能推断生产数据已经损坏。
