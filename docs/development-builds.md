# 依赖与构建入口

三仓在各自 `.codex/environments/environment.toml` 提供相同的检查、依赖准备、定向构建、类型检查和收尾动作。setup 只检查工具。从目标仓运行：

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
