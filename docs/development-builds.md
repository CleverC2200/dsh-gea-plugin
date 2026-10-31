# 依赖与构建入口

三仓的原生 Actions 由各自 `.codex/environments/environment.toml` 维护，setup 只检查工具。先从项目根 `docs/agents/current-development.md` 进入本票冻结输入，再核登记 checkout、HEAD、owner 和未提交修改。已有任务保留自己的输入和动作默认值。

GEA 桌面安装版和源码开发实例使用系统分配的监听端口，通过 Host 就绪回执获取实际地址，不约定固定服务端口。项目的源码 Host 入口 `pnpm start` 默认 `--port 0`；开发时保留各自的 home、profile 和 Electron userData，不复用官方客户端的 `19387`，也不把测试选出的空闲端口写成新的固定默认值。需要固定端口的显式 `--port` 或 `webserver.config.port` 覆盖由该实例维护者负责避让。

本地轻预检与影响计划使用现有开发 CLI，从目标仓运行：

```sh
node ../dsh-gea-plugin/scripts/development-tasks.mjs preflight
node ../dsh-gea-plugin/scripts/development-tasks.mjs plan --base <本票完整基线SHA>
```

GEA 本仓使用 `scripts/development-tasks.mjs`。未给 `--base` 或 `SOURCE_BASE_SHA` 时，轻入口从当前 HEAD 比较。它将 base 到 HEAD 的已提交差异、暂存、未暂存和 Git 未忽略的新文件合并为当前工作树范围；删除和改名保留旧路径参与影响分析。输出标记 `scope=local-working-tree`，HEAD 只标识提交，不能代替未提交字节或冻结候选验收。

`preflight` 只运行冷目录资源合同、适用语法、差分空白和已变更 workflow 的语义检查。workflow 检查复用 `scripts/workflow-preflight.mjs`；工具缺失时按错误提示将 `ACTIONLINT` 指向本票自有的固定版本可执行文件后重试。工具不会安装 actionlint、依赖、SDK 或桌面，也不启用 hook。Python 资源仍需当前资源合同使用的 Python 解释器。

知识引用沿现有 Node CLI 执行。Manage/GEA 的配置还引用 Core commandRoot，缺少其源码包时明确返回 `knowledge.status=deferred`、缺失路径和原因；Workbench 配置还要求编译后的包导出，也明确延后。所需输入已就绪的检查可以前置失败。准备相应材料后仍运行原 `check:knowledge`。轻预检不执行 lint、format、类型、行为或联合检查；计划声明的材料与检查仍由现有执行入口负责。各项检查通过只证明实际运行的范围。

`plan` 复用 source-quality 与共享 sourceChecks，输出实际文件、测试和材料需求，保存既有 `.runtime/source-checks-plan.json`。它不准备材料、不运行测试；未知源码仍按原选择规则拒绝。代码计划使用相邻三仓当前 HEAD，单仓冷资源检查不因此要求 Core。

项目根的新增轻动作要求显式 `DSH_DEVELOPMENT_INPUT`，沿 `tools/development.mjs preflight|plan --input <本票绝对输入路径>` 核三仓包身份、登记 HEAD 和开发工具源码后调用同一 CLI。它只对这两项动作省去 Core 核验；既有准备、构建、验收和收尾动作保持原输入要求。

依赖准备、定向构建和收尾仍使用原动作：

```sh
node ../dsh-gea-plugin/scripts/development-tasks.mjs check
node ../dsh-gea-plugin/scripts/development-tasks.mjs prepare
node ../dsh-gea-plugin/scripts/development-tasks.mjs build --target plugin
node ../dsh-gea-plugin/scripts/development-tasks.mjs finish
```

版本、锁、本地源路径和安装许可由当前仓 package、锁及 workspace 配置负责。依赖准备与构建要求固定 SDK 已准备；工具不会修改共享 SDK。冷 SDK 由 owner 在独立 checkout 使用 Manage 既有 SDK 准备入口完成。

准备动作先核锁、Node/ABI/平台、管理器、本地链接源、安装元数据与直接依赖 manifest。有效回执复用当前 checkout 的依赖；失效则冻结安装。它不做依赖树每个文件的完整性审计。Manage 关闭隐式 prepare，GEA 保留 allowBuilds。工作树不共享可写 node_modules/lib；包内容缓存沿各仓管理器使用。

构建动作沿现有目标运行，核三仓作者源、实际 SDK 产物、工具、依赖状态、构建环境和完整输出哈希后复用。测试或文档变动不使编译缓存失效；回执保留原编译提交和当前核验提交。默认 plugin；Workbench 另有 all，Manage 有 client，GEA 有 host/client。

容量策略与预算只有 `scripts/build-admission.mjs` 一份。准入读取实际输出卷剩余空间，同卷重型写入串行，watch 保留预算并拒绝同 checkout 写入。正常结束只释放自己的占用记录；异常遗留记录保留并拒绝后续写入，先核 PID、任务输入和打开文件再按既有清理流程处理。准入不是系统配额，其他程序和 swap 仍可消耗空间。

`verify --input <absolute candidate.json> --sha256 <original bytes SHA256>` 调用既有完整 quality 门禁；本机默认做定向验证，常规完整验证放到登记 GitHub Actions。源码检查、CI、真实安装与业务验收分别留证。

Workbench/Manage 原始 TGZ 使用 `scripts/pack-raw.mjs --input <absolute input.json> --repo <repo> --destination <absolute new output directory>`。输入中对应仓需提供现有交付合同的 path/head/buildReceipt；构建动作生成的回执可直接使用。目标父目录须存在。工具核明确 cwd、包身份、干净源、锁与构建产物，再预览允许文件、禁敏感隐藏文件并忽略打包脚本，写包后核归档。GEA 单包与桌面包继续沿原入口。

项目根的普通三包交付使用已采用的版本化 launcher：

```sh
node tools/development.mjs deliver --input "$DSH_DELIVERY_INPUT" --destination "$DSH_DELIVERY_DESTINATION" --tool-head "$DSH_DELIVERY_TOOL_HEAD" --runtime "$DSH_DELIVERY_RUNTIME"
```

`DSH_DELIVERY_INPUT` 为[三包交付合同](package-delivery.md)的绝对 request 路径，`DSH_DELIVERY_DESTINATION` 为绝对新目录，`DSH_DELIVERY_TOOL_HEAD` 为已采用工具 checkout 的完整提交 SHA，`DSH_DELIVERY_RUNTIME` 为本票独立运行依赖目录。交付动作要求显式提供这些值，不使用稳定开发输入的默认值。launcher 核实际工具 HEAD 及 runner、受控 loader、本地模块和合同的已提交字节，只运行同一 `deliver-packages.mjs` 一次，标准输出直接沿用原受控回执并补工具与 runtime 来源。它仍按原 request 核三仓/Core、源码锁、构建回执及包内容；owner 打包子程序取自 request 的 GEA checkout。采用新工具不改绑历史源码、SDK、主环境或在用客户端，`packaged` 的安装与业务验收边界仍见原合同。

runtime 只需[固定 manifest](../scripts/delivery-runtime/package.json)与[固定小锁](../scripts/delivery-runtime/pnpm-lock.yaml)登记的 `tar`、`semver` 及其依赖，不需要 GEA 的完整依赖或 SDK。首次准备时，将这两份已提交文件复制到本票独有的绝对目录，沿仓库固定管理器执行：

```sh
cd "$DSH_DELIVERY_RUNTIME"
corepack pnpm install --frozen-lockfile --ignore-scripts --prefer-offline
```

只复用公共内容 store，runtime 保持独立安装图。入口核 manifest/lock 与工具合同字节一致、直接包名称/版本匹配源码声明且位于 runtime 内。受控 loader 只重定向工具对 `tar`、`semver` 的导入，依赖解析也须留在该 runtime。它不审计安装包的每个文件，也不把保留在历史环境的依赖当作运行来源。

## 任务输出收尾

依赖与构建回执记录 owner、来源、用途和可再生输出；隔离验证目录记录生命周期。原 `finish`、`report` 不带输出清单时仍返回 `report-only`。它们不证明任意 `.scratch` 输出已经处置。旧目录没有回执时按未知保留。

任务 owner 将清单放在本票输出目录，以原票授权确定自己的输出范围。任务完成时执行 `finish --outputs`：声明为 `cleanup` 的可再生产物由工具检查并回收；`report` 始终只读。未声明、缺少恢复来源或检查不通过的项保持原状。工具不授予额外删除权限，也不在后台定时扫描。

```sh
node scripts/development-tasks.mjs finish --outputs /absolute/task/outputs.json
```

清单使用绝对物理路径。`roots` 互不重叠，必须覆盖清单所在任务目录；任务目录内除清单自身外的所有条目都需登记。若要核对别的已结束输出，只加入已经核准的精确叶项，保留其相邻目录。现存根检查实际文件、目录和符号链接；遗漏、路径越界、重叠、链接逃逸或未知链接目标均返回 `needs-disposition`。

```json
{
  "schemaVersion": 1,
  "task": "本地票路径或ID",
  "owner": "本票owner",
  "roots": ["/absolute/task"],
  "items": [
    {
      "path": "/absolute/task/runtime",
      "kind": "generated",
      "disposition": "retain",
      "reason": "当前验收窗口仍使用，窗口验收结束后退场",
      "restoreFrom": ["/absolute/retained/input.json", "/absolute/retained/build-receipt.json"]
    },
    {
      "path": "/absolute/task/original-failure.json",
      "kind": "failure-evidence",
      "disposition": "retain",
      "reason": "必要原始失败证据"
    }
  ]
}
```

`kind` 为 `generated`、`artifact`、`source`、`failure-evidence` 或 `user-data`。保留项需实际存在且给出理由。源码、最终交付包、必要原始失败和用户状态只支持保留。`generated` 的保留和退场都需指向自身目录外仍可读取的恢复来源文件；理由写明仍在使用的 owner/读者和后续退场条件。`pending` 或缺少处置保持未完成。

自动回收使用 `kind: "generated", disposition: "cleanup"` 和 `restoreFrom`。只登记本票已完成、可由保留来源重建的精确叶目录，例如独立构建输出或旧安装图；当前主环境和仍需验收的环境用 `retain` 并写明退场条件。自动回收只接受目录。工具拒绝源码仓、Git 已跟踪和未忽略的未跟踪文件、Git 锁及已识别的用户状态；保护名同时检查目标自身、祖先和子项，保留全部源码、独有提交及未提交改动，不代替源码差异迁移。整个工作树继续由 owner 核 GitHub 覆盖及必要差异，再用 Git 原生方式退出。

每个回收项执行实时 `lsof`、进程参数及项目/技能入口符号链接检查，检查失败、依赖仍引用或恢复来源将被删除时跳过并报告；不关闭读者。检查支持 macOS/Linux，其他平台保留原物并报告未支持。检查是当次观察，owner 在 finish 期间保持本票停止生产新输出。自动回收不遍历删除未登记项，也不清理会话和 Skill 的在用版本。

通过实时检查后，先在清单旁原子写入 `<outputs>.cleanup.json` 的 prepared 记录，再删除并持久化完成回执，将该项改为 `remove`。重复执行读取实际状态，不重复删除。若进程在删除后退出，下一次核原进程已退出、prepared 记录及路径实际缺失后续写回执，标记 recovered，不追认为本次实时检查或删除。未成功项仍为 `cleanup`，退出 1 并报告阻断原因。存在未声明输出、路径问题或恢复来源缺口时整批保持原状。并发 finish 通过清单旁独占锁互斥，锁归属未知或原进程仍在则阻断；原进程已退出的匹配锁可以恢复。无法确认的中断状态交由 owner 核对。事务临时写及 claim 放在 `<outputs>.finish-state` 内，以 task/owner 标记归属，只接纳已知的普通元数据文件。持有进程退出后恢复匹配 claim、回收本事务临时写；未知内容或未知锁保持阻断。原回执及清单保留，不备份整套生成环境。

已由其他获准流程完成的退场项用 `disposition: "remove"` 和 `cleanupReceipt` 指向原清理 journal。该 journal 的 `items` 中必须只有一条同路径记录，`removed` 为 true，`startedAt`、`completedAt` 有效且先后有序；实际目标必须已经不存在。只写一个计划、成功摘要或清单自报 removed 均不通过。恢复来源和 journal 留在删除目标外。已删根必须有同路径退场项，不因根已不存在而省去核对。

只保留删除后无法从现存来源恢复的内容。源码提交及独有未提交改动、锁、冻结输入、必要原始失败、实际独有差异和关键回执通常已足够。可重建的完整依赖、SDK、解包应用和运行目录登记恢复来源并完成退场；不要因为同目录有证据而再备份整套环境。复用原包、原比较和原清理回执，执行前仅刷新会变化的占用与引用。目录分配量和 APFS 可用空间分别核算。

`outputDisposition` 回读登记条目、缺口和保留空间。每个保留路径用 `du -sk` 量化为 `allocatedBytes`，合计为 `retainedAllocatedBytes`；测量失败保持未完成。这是目录分配量，不能当作独占 APFS 块或可回收量。保留整个 Home 或 evidence 父目录时，审阅者仍需核对它的实际体量、具体保留范围和理由，不能用类别名代替判断。

全部通过才返回 `disposition-complete`，仅表示声明范围的输出处置完成；`scope=declared-task-outputs` 限定范围。`performsCleanup` 仅在本次确实删除时为 true；`livePreflightVerified` 仅在本次所有自动回收项都完成检查及删除时为 true。历史回执和只读 report 不追认过去的占用状态，不替代业务、Native、发布或整票验收。带清单的 `finish` 遇到缺口退出 1；`report` 只报告并保持原退出合同。

项目根启动器的版本化源码在 `scripts/plugin-split-development.mjs`。根 `tools/development.mjs` 从稳定主输入读取已接纳的 GEA 工具位置和提交，核固定 HEAD 后调用该脚本；串行接纳新的工具源码后同步主输入，不另外保留一套完整工具环境。脚本核自身及唯一输出核对模块的字节等于当前 HEAD，继续按原冻结输入核三仓、Core 和旧 GEA 工具，不覆盖旧工具或改绑输入。根 `finish` 先输出原占用报告，再对本票输出清单执行回收及核对；缺少清单也返回 `needs-disposition` 并退出 1。根 `report` 不带清单时保持原占用报告。

```sh
node tools/development.mjs report --input /absolute/frozen-input.json
node tools/development.mjs finish --input /absolute/frozen-input.json --outputs /absolute/task/outputs.json
```

根收尾入口输出为逐行 JSON，最后一行为本票处置和实际 `toolSource.path/head`。只有实现合并或测试通过，不能声称根入口已采用；应从根原路径实际运行并保存工具来源、未改的冻结输入和最终处置回执。该链接仍是 reader，回收 implementer 时保留被链接的 integration。

## PR 合并后的自动收尾

任务创建 PR 后，owner 将重要改动、验证结果和未完成边界写进 PR 正文，再用根入口 bind-pr --input <本票输入> --repo <仓库标识> --pr <编号> --outputs <本票清单> 登记。一个任务的所有 PR 都登记在同一清单；推送新提交或更新正文后重新登记。登记冻结准确 head 和远端正文摘要，不把本地“已完成”字段当作合并证明。

登记入口首次写入 PR 后返回 `watch-required` 并退出 2，同时给出 `automation_update` 的原生任务请求。登记 owner 用 `list_projects` 将请求的 projectId 补为本项目 id，复用同标记的独立检查，或通过原生工具创建。请求为 `kind=cron`、`destination=local` 的独立项目任务，不挂到原聊天。随后用相同 `bind-pr` 参数加 `--watch-id <原生工具返回的id>` 完成登记。只有检查已启用、项目路径及本票指令一致才返回 `tracking`；缺少检查、暂停、heartbeat 或不匹配都不能声称登记完成。后续同组 PR 共用清单中已绑定的检查，按返回状态处理失效检查，不重复创建。

独立检查先运行 `watch-plan --outputs <本票清单>`。返回 `action=stop` 时通过原生工具删除自身，不读取聊天或写临时文件。返回 `check` 才采集新鲜的原生活跃会话快照，调用 `finish-merged --outputs <本票清单> --activity <本轮快照>`，并在成功或失败时删除临时快照。每票使用自己的临时文件，通过普通文件写入，不生成 apply_patch 编辑卡片。收尾返回 `watch.action=stop` 后删除对应检查；本票清单已从其他入口退出时，下次检查也直接停止。清单专属标记用于只读定位自己的原生配置，删除只调用 `automation_update`，不直接改自动任务文件。等待合并或在用项保留时继续检查同一票，不另建系统调度服务。

根 finish-merged 不带清单时仍可扫描项目 .scratch/.parallel 下已登记的 outputs.json，不跟随符号链接，不扫描依赖和 Skill 树。它只读取登记的三仓 GitHub PR，要求同仓 main、准确 head、正文摘要、merged 与合并提交全部吻合；全部 PR 合并后才自动调用 finish。尚未合并、关闭未合并、读取失败和记录变化都保留本地文件。独立原生检查只调用本票入口，登记完成后不需要用户手工执行 finish。

验收与过程资料用 acceptance-evidence/process-evidence 加 cleanup 声明；任务已确认合并且重要情况已在 PR 保存时，artifact/failure-evidence 也可按本次授权退出。手工普通 finish 仍拒绝清理这些类别。原始业务材料、用户数据和必要源码差异不归为过程资料。来源和 GitHub 未覆盖改动保持 source/user-data 或移入必要源文件，不生成整套环境备份。

已登记的 linked worktree 只有在 head 已被对应 PR 覆盖、源码无修改/未跟踪/未声明 ignored 文件、没有 Git 锁、进程和符号链接使用者时才以 Git 原生命令退出，不使用 force。当前主三仓/Core 永不作为任务环境退出。仍在用的项留待后台下一次核对。成功回收全部声明项和工作树后，移除本票清单、日志和事务元数据，最终重要说明只保留在 PR；本地不再保留验收和过程报告副本。未知文件保持阻断。

自动入口要求后台提供两分钟内的原生聊天活动快照，包含当前 host 完整分页的 thread id/status/cwd 和显式工作树路径；读取不完整、快照过期或未知状态保留。登记同时绑定创建任务的 CODEX_THREAD_ID；其他仍在执行的 owner 会阻断退出。当前收尾执行器允许处理自己的已合并任务，其他活动聊天的具体任务路径继续保护。用户技能与可执行入口的符号链接也参与工作树读者检查。只读借用主依赖的 node_modules 链接在全部保护通过后只 unlink 链接本身，绝不删除主依赖；Git 原生退出失败时恢复链接。
