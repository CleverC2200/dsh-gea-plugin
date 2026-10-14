# CI Core 门禁策略

当前交付基线固定为 Core `0.2.0-rc.2`。阻断与兼容输入统一维护在 `scripts/ci-core-policy.json`；`supported-cores.json` 保留更完整的兼容目录。

`candidate-quality` 只运行 required 基线。rc.2 的质量、适用的 Windows 归档及安全检查仍是合并条件。最终门禁继续拒绝失败、取消、缺失或跳过的必需任务。

`candidate-compatibility` 通过 `workflow_dispatch` 独立运行 alpha，仍使用冻结的三仓完整 SHA 和完整质量命令。失败保留在该工作流的日志、产物及结论中。它不作为 required merge context，也不要求它完成或成功后才接收 rc.2。

合并核验必须绑定候选组或实际 main 的完整三仓输入，核 rc.2 必需任务和适用的安全检查。按工作流身份单独记录 alpha，不再以“所有 check-run 一律成功”判断。alpha 未运行或失败不能记成兼容通过；只凭任务名包含 alpha 也不能豁免其他检查。

本次只调整 CI 接收范围。插件包版本、锁文件、业务断言、预算、Core 源码及私有 Core 的验收范围保持原约定。在途运行仍按原双 Core 定义解释。将策略应用到重新审查并冻结的输入组后，分别核验候选组和合并后的实际 main。

## PR 59 的定向接收例外

2026-10-14 用户明确要求停止全量 CI，并授权定向门禁后继续合并 GEA。该例外仅接收 PR 59 的固定产品提交 `99067baee958a2260ef3735c6b82818253e4906b` 及其仅追加 CI 接线、测试和本节的合并树。`plugin-update-pr-lane.mjs` 拒绝产品变更、非本仓 PR 或未包含该提交的输入。后续 main 一旦出现例外文件以外的变更，恢复原全量路径；其他 PR 和显式联合 dispatch 保持原路径。

定向路径绑定实际 GEA event SHA、已合并的 Workbench/Manage 完整 SHA 和 required rc.2 SDK。只运行 fast 质量、更新事务/接线、签名来源、包版本、构建与交付脚本及路由边界测试，保留三包构建。它不启动 Web/浏览器、业务合同全套或全量测试，不证明 Native/OSS 验收。聚合检查只接受本次实际选中的任务成功；失败、取消、缺失仍阻断。GitHub 分支保护不变。
