# 测试计划、并发与历史权重

`quality-test-execution.mjs` 为 required/affected 完整集合生成计划并核验逐文件执行回执。分片数沿用 `plannedShardCount`：无 Profile 使用一片，其余按历史成本和未知文件保守权重计算，上限十四片，实际非空片数来自冻结计划。分片计费使用当前平台文件；委派给macOS独立门禁的文件继续保留在完整选择及平台任务中，不计入Linux的权重。文件并发数不改变这个公式，也不减少选择集合。 Node 参考墙钟取220秒与当前选择集中最长已测单文件耗时的较大值，避免不可拆分文件已经超出220秒时继续增加runner。未知文件仍使用至少400秒或最长已测文件的较大权重，不提高已测下界，也不转成已知估计。两槽保守计费不随实际文件并发数变化。该参考来自旧完整 hosted 样本的350秒启动及准备预留、30秒收尾预留，从600秒目标中扣除；主线的单分片 producer 路径继续按原规则执行。固定预留不是本轮观测，也不保证额外分片必然更快，最终仍须核完整 hosted 实测。

分配保持原先未知优先、已知耗时降序及空片先填。此后对每个候选片，将待加入文件按 Node 实际文件名顺序排入固定数量的槽，选择预计最早完成的片，平局按片 ID。未知文件只使用保守排序权重；包含未知文件的预计耗时仍为 `null`。

公共 CLI 接受 `--test-file-concurrency 2|3|4`，默认二；Mac 和普通调用保持默认。显式三或四并发的调用在 plan、prepare、build、checks、tests、summary 及回执校验阶段传相同参数。后续阶段重算的计划必须与 `--execution-plan FILE` 完全一致；省略显式并发参数或改为其他并发数会拒绝。Node 实际使用冻结计划中的 `--test-concurrency`。

`verifyExecutionPlan(plan)` 公开原有计划哈希、完整覆盖、片标识和非空检查，并校验并发只能为数值二、三或四。`verifyExecutionCapacity({concurrency})` 在三或四并发时读取当前机器的 `os.availableParallelism()` 和 `os.totalmem()`，要求至少四个可用 CPU、12884901888 字节内存，未知或不足以 `QUALITY_TEST_CAPACITY_REQUIRED` 拒绝；不自动降级。二并发不增加容量下限。可选 `resources` 是小测试的系统边界入口，真实 worker 省略它。执行入口在启动 Node 前重新检查，真实容量观测写入执行回执，动态观测不进入确定性计划。

三并发计划通过本次真实容量校验后，`runExecutionPlan` 在每个非空片的子 Node 启动环境中设置 `UV_THREADPOOL_SIZE`。`active=min(3,片文件数)`，池预算为 `min(4,max(1,floor(可用CPU/active)))`；四CPU时一文件为4、两文件为2、至少三文件为1，覆盖继承环境、调用方 environment 和 env-file 的同名值。二/四并发保留原环境协议。每片 result 同时保留本次 `capacity` 及 `libuvPool` 的 `declared` 大小、activeFiles、CPU及来源，汇总只保留 results 时仍可按各片实际容量独立重算，不能借一片容量解释其他片；这是启动声明，不是 native pool 实际线程观测或进程树CPU硬限制。该值也会被默认继承环境的测试文件及Host/launcher后代继承；启动后不动态改变，片尾只剩一文件时不会扩池。C3am 本机小语料不能证明两文件档、真实Linux/Profile或600秒收益，单片与全轮仍须 fresh hosted 实测。

当前 `quality-test-timings.json` 的162个 Linux 样本来自 [run 39004545625](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/39004545625) / attempt 1，精确源码、Node、Core、计划、构建、选择集及来源摘要由该文件登记。提取前使用原冻结计划核验同轮全部14个 worker 的逐文件回执；文件并发三。同轮 Linux/Darwin 共163文件完整执行，20个 job 的功能结果通过，completed 墙钟688秒，600秒目标仍失败。样本仅为 `historical-reference-only`、`not-acceptance` 的路由参考。模拟分配不能证明实际收益，新的完整 hosted 运行负责验收。

此前 [run 38822102215](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/38822102215) 的167个 Linux 样本及636秒性能失败仍保留在历史提交和原证据中。本次只使用新轮完整实测，旧轮测过而本轮未测的文件仍为未知，不跨轮回填。三/四并发容量下限、Source 90000ms、Host 45000ms 和业务动作预算保持原约定。

Profile 夹具将固定来源文件交给原准备入口，只在准备需要时读取记录，完整来源与产物校验仍由 `prepareSourcePlugins` 执行。需要直接消费构建资产的调用方继续使用完整解析入口；已有 selection 与 coreOnly 不读取未使用的来源文件。准备前取消保留原取消原因并清理私有临时目录，不先触碰尚未使用的输入。
