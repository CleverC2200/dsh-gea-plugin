# 测试计划、并发与历史权重

自动 `source-quality` 联合检查的当前分片与覆盖迁移见[测试覆盖对应](test-coverage-migration.md)。以下 `plannedShardCount` 描述手动 quality 入口；本票不以固定完成时长作为验收门槛。

`quality-test-execution.mjs` 为 required/affected 完整集合生成计划并核验逐文件执行回执。分片数沿用 `plannedShardCount`：无 Profile 使用一片，其余按历史成本和未知文件保守权重计算，上限十四片，实际非空片数来自冻结计划。文件并发数不改变这个公式，也不减少选择集合。 Node 参考墙钟按220秒规划，两槽保守计费不随实际文件并发数变化。该参考来自旧完整 hosted 样本的350秒启动及准备预留、30秒收尾预留，从600秒目标中扣除；主线的单分片 producer 路径继续按原规则执行。固定预留不是本轮观测，也不保证额外分片必然更快，最终仍须核完整 hosted 实测。

分配保持原先未知优先、已知耗时降序及空片先填。此后对每个候选片，将待加入文件按 Node 实际文件名顺序排入固定数量的槽，选择预计最早完成的片，平局按片 ID。未知文件只使用保守排序权重；包含未知文件的预计耗时仍为 `null`。

公共 CLI 接受 `--test-file-concurrency 2|3|4`，默认二；Mac 和普通调用保持默认。显式三或四并发的调用在 plan、prepare、build、checks、tests、summary 及回执校验阶段传相同参数。后续阶段重算的计划必须与 `--execution-plan FILE` 完全一致；省略显式并发参数或改为其他并发数会拒绝。Node 实际使用冻结计划中的 `--test-concurrency`。

`verifyExecutionPlan(plan)` 公开原有计划哈希、完整覆盖、片标识和非空检查，并校验并发只能为数值二、三或四。`verifyExecutionCapacity({concurrency})` 在三或四并发时读取当前机器的 `os.availableParallelism()` 和 `os.totalmem()`，要求至少四个可用 CPU、12884901888 字节内存，未知或不足以 `QUALITY_TEST_CAPACITY_REQUIRED` 拒绝；不自动降级。二并发不增加容量下限。可选 `resources` 是小测试的系统边界入口，真实 worker 省略它。执行入口在启动 Node 前重新检查，真实容量观测写入执行回执，动态观测不进入确定性计划。

三并发计划通过本次真实容量校验后，`runExecutionPlan` 在每个非空片的子 Node 启动环境中设置 `UV_THREADPOOL_SIZE`。`active=min(3,片文件数)`，池预算为 `min(4,max(1,floor(可用CPU/active)))`；四CPU时一文件为4、两文件为2、至少三文件为1，覆盖继承环境、调用方 environment 和 env-file 的同名值。二/四并发保留原环境协议。每片 result 同时保留本次 `capacity` 及 `libuvPool` 的 `declared` 大小、activeFiles、CPU及来源，汇总只保留 results 时仍可按各片实际容量独立重算，不能借一片容量解释其他片；这是启动声明，不是 native pool 实际线程观测或进程树CPU硬限制。该值也会被默认继承环境的测试文件及Host/launcher后代继承；启动后不动态改变，片尾只剩一文件时不会扩池。C3am 本机小语料不能证明两文件档、真实Linux/Profile或600秒收益，单片与全轮仍须 fresh hosted 实测。

当前 `quality-test-timings.json` 的来源、提交、环境和文件集合以表内 `source`、`inputs` 和 `files` 为准。更新来自同一完整通过运行的回执；原始 CLI 导出保留，提交的长期参考表沿用 `historical-reference-only`、`not-acceptance` 约定。来源标签不改变测量值或使参考成为验收证据，不混轮回填。此前 [run 39095827120](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/39095827120) 的 176 文件样本及未达旧性能目标的结果仍保留在历史提交和原 artifact，不再指代当前表。

[`quality-test-timings.mjs`](../scripts/quality-test-timings.mjs) 在准备前按实际 checkout 过滤样本。每条记录绑定测量时的测试文件 SHA256 和关键 fixture SHA256，Profile 文件另绑定准备、选择、admission 及浏览器公共入口。文件或关键 fixture 改变、删除，或者 Node、平台、Core、文件并发变化，旧估计都会失效；没有字节绑定的旧格式也视为未知。失效原因进入计划来源，未知耗时继续为 `null`，仅使用原保守分片权重。新的测试文件不借用旧同名或其他文件的时长。刷新时须从同一冻结 run 的完整回执取样，并从该 run 的源码 HEAD 取摘要。

此前一次历史拆分将当时 `returned-resubmit-web.test.mjs` 的 11 个用例分成三个测试文件。当前 17 项场景的四文件对应见[测试覆盖对应](test-coverage-migration.md)。它们共用 [`returned-review.mjs`](../tests/fixtures/returned-review.mjs) 的纯 fixture，每个 case 仍有独立状态、私有 runtime、完整源码组合校验与 window admission；测试函数体和业务断言保留。不能把原单文件 330486.690586ms 当成新文件已测耗时，新文件先记未知。Source 90000ms、Host 45000ms、容量下限与业务动作预算保持。

上述历史 11 个 case 的生命周期证据中，准备与到可操作窗口累计占 83.6%，不是固定 25 秒清理等待。跨 case 复用基础层必须先证明它只读、绑定同组源码与完整外部依赖字节，并在每个 case 单独派生配置、budget、selection 与授权。现有组合包含私有路径，不能直接当成可重放授权缓存；本轮保留完整逐 case 检查，实际墙钟收益由新冻结输入同范围 hosted 运行验证。

Profile 夹具将固定来源文件交给原准备入口，只在准备需要时读取记录，完整来源与产物校验仍由 `prepareSourcePlugins` 执行。需要直接消费构建资产的调用方继续使用完整解析入口；已有 selection 与 coreOnly 不读取未使用的来源文件。准备前取消保留原取消原因并清理私有临时目录，不先触碰尚未使用的输入。

当前手动完整源码集合使用 `test:full`，直接枚举顶层 test、contract 和 browser 文件，保留严格 reporter。它不再解析另一条 package script 来计算余集，也不作为 GitHub 定时全量任务。工程脚本、桌面 unit 和安装验收继续各自的受影响或人工入口。
