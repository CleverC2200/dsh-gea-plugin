# 依赖与构建入口

三仓的原生 Actions 由各自 `.codex/environments/environment.toml` 维护，setup 只检查工具。先从项目根 `docs/agents/current-development.md` 进入本票冻结输入，再核登记 checkout、HEAD、owner 和未提交修改。已有任务保留自己的输入和动作默认值。

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

先核本票 checkout、HEAD 与本地输入。版本、锁、本地源路径和安装许可由当前仓 package、锁及 workspace 配置负责。固定 SDK 必须已准备；工具不会修改共享 SDK。冷 SDK 由 owner 在独立 checkout 使用 Manage 既有 SDK 准备入口完成。

准备动作先核锁、Node/ABI/平台、管理器、本地链接源、安装元数据与直接依赖 manifest。有效回执复用当前 checkout 的依赖；失效则冻结安装。它不做依赖树每个文件的完整性审计。Manage 关闭隐式 prepare，GEA 保留 allowBuilds。工作树不共享可写 node_modules/lib；包内容缓存沿各仓管理器使用。

构建动作沿现有目标运行，核三仓作者源、实际 SDK 产物、工具、依赖状态、构建环境和完整输出哈希后复用。测试或文档变动不使编译缓存失效；回执保留原编译提交和当前核验提交。默认 plugin；Workbench 另有 all，Manage 有 client，GEA 有 host/client。

容量策略与预算只有 `scripts/build-admission.mjs` 一份。准入读取实际输出卷剩余空间，同卷重型写入串行，watch 保留预算并拒绝同 checkout 写入。正常结束只释放自己的占用记录；异常遗留记录保留并拒绝后续写入，先核 PID、任务输入和打开文件再按既有清理流程处理。准入不是系统配额，其他程序和 swap 仍可消耗空间。

`verify --input <absolute candidate.json> --sha256 <original bytes SHA256>` 调用既有完整 quality 门禁；本机默认做定向验证，常规完整验证放到登记 GitHub Actions。源码检查、CI、真实安装与业务验收分别留证。

Workbench/Manage 原始 TGZ 使用 `scripts/pack-raw.mjs --input <absolute input.json> --repo <repo> --destination <absolute new output directory>`。输入中对应仓需提供现有交付合同的 path/head/buildReceipt；构建动作生成的回执可直接使用。目标父目录须存在。工具核明确 cwd、包身份、干净源、锁与构建产物，再预览允许文件、禁敏感隐藏文件并忽略打包脚本，写包后核归档。GEA 普通包、桌面包和交付继续沿原入口。

收尾只报告。依赖与构建回执记录 owner、来源、用途和可再生输出；隔离验证目录记录生命周期，并始终保护 home/workspace、日志与验收证据。旧目录没有回执时按未知保留。需要退场的输出先用项目既有 cleanup_checks 计划核在途输入、读者、打开文件和 Git 引用；不自动删目录或用户资料。
