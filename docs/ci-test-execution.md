# 测试计划、并发与历史权重

`quality-test-execution.mjs` 为 required/affected 完整集合生成计划并核验逐文件执行回执。分片数沿用 `plannedShardCount`：无 Profile 使用一片，其余按历史成本和未知文件保守权重计算，上限十四片，实际非空片数来自冻结计划。文件并发数不改变这个公式，也不减少选择集合。

分配保持原先未知优先、已知耗时降序及空片先填。此后对每个候选片，将待加入文件按 Node 实际文件名顺序排入固定数量的槽，选择预计最早完成的片，平局按片 ID。未知文件只使用保守排序权重；包含未知文件的预计耗时仍为 `null`。

公共 CLI 接受 `--test-file-concurrency 2|3|4`，默认二；Mac 和普通调用保持默认。显式三或四并发的调用在 plan、prepare、build、checks、tests、summary 及回执校验阶段传相同参数。后续阶段重算的计划必须与 `--execution-plan FILE` 完全一致；省略显式并发参数或改为其他并发数会拒绝。Node 实际使用冻结计划中的 `--test-concurrency`。

`verifyExecutionPlan(plan)` 公开原有计划哈希、完整覆盖、片标识和非空检查，并校验并发只能为数值二、三或四。`verifyExecutionCapacity({concurrency})` 在三或四并发时读取当前机器的 `os.availableParallelism()` 和 `os.totalmem()`，要求至少四个可用 CPU、12884901888 字节内存，未知或不足以 `QUALITY_TEST_CAPACITY_REQUIRED` 拒绝；不自动降级。二并发不增加容量下限。可选 `resources` 是小测试的系统边界入口，真实 worker 省略它。执行入口在启动 Node 前重新检查，真实容量观测写入执行回执，动态观测不进入确定性计划。

三并发计划通过本次真实容量校验后，`runExecutionPlan` 在每个非空片的子 Node 启动环境中设置 `UV_THREADPOOL_SIZE`。`active=min(3,片文件数)`，池预算为 `min(4,max(1,floor(可用CPU/active)))`；四CPU时一文件为4、两文件为2、至少三文件为1，覆盖继承环境、调用方 environment 和 env-file 的同名值。二/四并发保留原环境协议。每片 result 同时保留本次 `capacity` 及 `libuvPool` 的 `declared` 大小、activeFiles、CPU及来源，汇总只保留 results 时仍可按各片实际容量独立重算，不能借一片容量解释其他片；这是启动声明，不是 native pool 实际线程观测或进程树CPU硬限制。该值也会被默认继承环境的测试文件及Host/launcher后代继承；启动后不动态改变，片尾只剩一文件时不会扩池。C3am 本机小语料不能证明两文件档、真实Linux/Profile或600秒收益，单片与全轮仍须 fresh hosted 实测。

历史文件 `quality-test-timings.json` 的167个 Linux 样本来自 [run 38810045174](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/38810045174) / attempt 1 / GEA `3f205ba454c10cbf165a02e0255488febab871a7`，原文件并发三。同轮 Linux/Darwin 共168文件、870个 case 全部通过，14个 worker 普通卸载成功、19个 required 上游 job 成功；final 因893秒超出600秒预算而失败，原失败保留。原始来源、平台、Node、Core、计划、构建、选择集及 provenance 摘要随样本保留，样本仅为 `historical-reference-only`、`not-acceptance` 的路由参考，不混轮回填。三/四并发的容量下限、Source 90000ms、Host 45000ms 和业务动作预算不变。未来未测文件仍为未知，刷新后的分配和估计不证明实际收益或600秒通过，须由新冻结输入的完整 hosted 运行验证。
