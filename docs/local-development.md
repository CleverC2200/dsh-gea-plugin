# 本地依赖与按需检查

工具链与精确版本从 `package.json` 的 engines、packageManager 和 devDependencies 读取，固定依赖由 `pnpm-lock.yaml` 提供。Core 与 peer 来自本任务冻结输入；Node 兼容范围不代表每个补丁版已验。

```sh
corepack pnpm --version
corepack pnpm install --frozen-lockfile --prefer-offline
```

每工作树保留自己的 node_modules、lib 和临时目录，仅复用 package store。不要混用 npm 安装开发依赖，不复制其他工作树可写输出。`verifyDepsBeforeRun: error` 拒绝过期依赖，不自动安装；只读知识检查无需产品依赖。

| 目的                   | 当前入口                            |
| ---------------------- | ----------------------------------- |
| 工程导航与源码声明     | `corepack pnpm run check:knowledge` |
| 监听 Host 与 client    | `corepack pnpm dev`                 |
| 只构建 Host            | `corepack pnpm build:host`          |
| 只构建 client          | `corepack pnpm build:client`        |
| 构建 GEA 插件          | `corepack pnpm build:plugin`        |
| 类型检查               | `corepack pnpm typecheck`           |
| 固定官方 Core 类型检查 | `corepack pnpm typecheck:official`  |
| 构建目标与 watch 合同  | `corepack pnpm test:build`          |

完整 build 也仅构建 GEA host/client；页面在同组 Workbench 按自己的工具链构建。watch 只编译，不启动应用，勿并发写同一输出。官方类型检查需要明确准备的只读 SDK 与 peer 声明，不能以旧 SDK 或历史产物代替当前输入。

只读交付核对使用 `pnpm run delivery:check --input request.json`；短接续增加 `--continuation`。预算、阶段、原依赖与授权从同次固定回执读取派生，详见 [交付核对 interface](delivery-check.md)。`pnpm run test:delivery` 只运行本地 fixture 回归。CLI 退出0仅表示报告生成，消费者需读取报告状态；此入口不启动应用或恢复自动化。

按授权启动与切换时复用 [源码组合说明](plugin-split-validation.md) 的明确五源和自有 runtime。可构建不等于窗口已获授权。旧 desktop:dev 使用已安装公司壳，属于历史入口，不作为当前官方客户端协议。

## Codex Local environments

仓内 `.codex/environments/environment.toml` 是实际配置。默认 setup 只核工具，安装由明确选择的 Action 执行，不自动构建。Actions 的命令、cwd 与是否持续 watch 按该文件核对，需要不同范围时运行公开命令，不新增任务识别或编排器。

配置存在与命令行通过不证明应用内 setup/Action 已验。实际新任务需核 cwd、工具、冻结锁和结果；安装与完整构建不和 watch 并发。本次清理不改变用户配置或清理脚本。

## 可选本地采样

```sh
corepack pnpm observe --task build --source terminal --condition existing-layout
corepack pnpm observe:report
corepack pnpm test:observe
```

采样仅主动调用时启用，普通命令不增加后台服务。来源和缓存条件是人工标签，默认 unknown；记录白名单任务、时间、退出/取消、版本、锁和 Git 摘要，不记录源码、业务内容、环境值或完整参数。原终端输出未由它存档或脱敏，依赖 reused 不等于构建缓存命中。

仅显式采样空间时扫描本仓相应目录，不扫描共享 store。APFS 目录占用与文件系统剩余空间分别报告。记录不能作为完整输入或跳过验证依据；轮转仅限自身合法完成记录，不删除依赖、未知或在途记录。Windows 保持普通命令，POSIX 采样不是跨平台验收。

开发 pnpm 锁、普通包 npm shrinkwrap 与实际 profile 锁有不同归属，沿 [安装说明](install.md) 的协议，不将开发检查当发布授权。原过程记录见 [历史开发说明](history/local-development-pre-agent-environment-04.md)。

## 当前候选的质量检查

自己的源码与依赖准备后，`corepack pnpm quality:fast` 检查增量 lint、格式、官方类型、活跃工程引用与质量 CLI 反例。它允许未提交修改。固定基线为 `041ef35e16effcf98ffe3b252b64512c704dc29a`，只有基线后未变化的旧债务可保留；缺目标、工具失败、摘要变化和 ignore 绕过都拒绝。默认目标枚举保留该基线 `.gitignore` 的生成物与第三方排除，新增 Git ignore 不能隐藏本地源码。`corepack pnpm lint:audit` 与 `corepack pnpm format:audit` 检查全量债务，不能把增量通过写成全量 audit 通过。

质量政策来自首次加入门禁的 `7e7a464a27e0e7e8e969aade44db11f81a40f2d9`。CLI 在运行工具前独立核完整 `quality-baseline.json`、两份 Ox 配置的固定字节，以及声明和本树实际安装的 oxlint 1.87.0/oxfmt 0.72.0。同步改规则或版本与 baseline 不能形成新通过；政策变更须另行审查，不能更新 baseline 吸收新增问题。换行仅接受原 LF 或完整 CRLF 渲染，不接受混合换行、重新序列化或改字段，不改写原件和证据。该换行合同的本地 fixture 通过不等于 hosted Windows 验收。

`corepack pnpm quality:ci --input /absolute/path/candidate-input.json` 要求干净且固定的三仓输入，先核实际 Git SHA、完整历史与原锁，再只读核 Manage 的公开 SDK 工具、原上游依赖和 Workbench 的共享候选检查。它运行同一 `quality:fast`、`test:contracts` 与完整 `test`。CI 自身绑定事件实际 SHA，peer 使用命令内冻结的兼容提交；本地最终整合组合另有自己的回执，不能把两个 tuple 视为同一组合。

显式最终组保留默认固定兼容组和 workflow 指针，另用原文件字节 SHA-256 声明实际源码。GEA 的相邻 Workbench 可以是 prepared dirty tree，故必须显式定位冻结输入中的干净 Workbench source。只在此模式加载该 source 的共享 reader；它核真实路径、package 身份、三仓 HEAD/full history/clean/提交内锁、Core Git/原锁/工具链和 CI 实际事件 SHA，不由 GEA 再解析一套 admission。

```sh
node scripts/run-quality-ci.mjs --phase verify-input --input /absolute/frozen-group.json \
  --final-group-sha256 ORIGINAL_FILE_SHA256 \
  --final-group-workbench /absolute/clean-workbench-source
```

`verify-input` 只读输出 candidate-source-only，SDK、质量、兼容、runtime 未验，不授予业务或发布权限。该定位路径必须与原文件中的 Workbench source realpath 一致，不能以 prepared 产物树替代。缺参数、未知参数、错 hash/事件/source/head/Core、dirty、重复仓或路径冲突都在准备前失败。冷 Core 若尚无 SDK 输出，可用 `--core-source /absolute/fixed-core-git` 核已有固定源码；仅 URL 不构成实际 Core proof。

这个只读 phase 只需 Node、Git 和固定源码，可直接调用 quality:ci 所声明的同一脚本。包管理器自身的依赖/store 准入另行核验；若 pnpm 在启动脚本前拒绝，就没有执行 admission，直接 Node 的通过不能记为该 pnpm 命令通过。实际 CI 仍需其自身环境的冻结安装及执行回执。

真正完整 quality 或 prepare phase 保留这三个显式输入参数，每条命令执行前后及成功回执输出前复核原文件未改；准备后完整 candidate 检查仍核实际 SDK 和 Workbench exports，不把 source-only 通过当成完整通过。默认模式不加载新 reader，不接受单独定位参数暗改选组。`corepack pnpm test:final-group` 独立检查此可选合同；它使用本树和相邻当前 peer 的完整 Git 冷克隆，必要时用 GEA_FINAL_GROUP_WORKBENCH_SOURCE、GEA_FINAL_GROUP_MANAGE_SOURCE、GEA_FINAL_GROUP_CORE_SOURCE 显式指定只读源码。此合同不进入默认 test/test:quality 通配，显式完整质量模式会执行它。

首次准备使用独立目录，GEA 与 Manage 源码放在 `<job-root>/candidate/<repo>`，Workbench 干净源码放在 `<job-root>/source/dsh-agent-workbench`，官方 Core 放在 `<job-root>/official-latest-standard`，原 link 依赖放在 `<job-root 的父目录>/current-mainline-closeout-44`。先按公开输入阶段生成声明，再显式准备：

```sh
node scripts/run-quality-ci.mjs --phase input --root /absolute/job-root --sha ACTUAL_GEA_COMMIT
corepack pnpm quality:ci --input /absolute/job-root/candidate-input.json --prepare-sdk --core-source https://github.com/deepseek-ai/deepseek-harness.git --prepare-inputs
```

准备阶段仅在独立 checkout 内按原工具链与冻结锁安装、编译库及 Core 静态网页。原 GenUI npm 资产与 Sidebar Git 源及摘要由 `scripts/quality-upstreams.json` 固定，`corepack pnpm quality:upstreams --root /absolute/upstream-root` 默认只读验证，增加 `--prepare` 才下载和构建。现有共享或借用目录拒绝准备写入。它不启动 Native、业务或模型请求，也不修改用户运行目录。首次 CI 需要明确的 peer contents-read 凭据，未配置时失败；最终 always 聚合拒绝失败、跳过、取消与缺结果。

完整 CI 显式开启源码窗口 fixture，Chromium 准备在本组 `.quality-browser` 中，所有服务和模拟模型端点只接受 loopback。完整 `test` 使用公开 reporter 拒绝必需测试的 skip，不能只按 Node 退出码把未执行的源码窗口称为全绿。该范围是源码 Host/profile 与本地 Web 集成，不能称为真实业务、模型服务或 Native 验收。

Source 用例沿现有 Node test 与 profile fixture 分段计时。每次准备最多 90 秒，实际就绪后清除准备计时，再按用例原 timeout 计动作；整例 Node 上限仍为原 timeout 加 90 秒。超时和父取消通过 Node 公开 signal 中止，清理等待已开始的准备收敛后停止自有进程。请求、模型、启动 45 秒和退出 15 秒期限保持原值。Source 的启动 45 秒从本次 launcher、有效 Host PID、冻结 Core/组合均匹配的公开 source-host.json 回执开始，准备阶段仍受 90 秒限制；旧回执不会启动或刷新计时。此额外准备预算仅在 `GEA_TEST_SOURCE_CORE=1` 启用，普通测试保持原期限。

依赖完整性 reader 的无 scope 路径最多并行读取 4 个文件，完整读取每个当前字节；发现顺序、有序摘要与最早错误保持。带 delivery readScope 的 guard 和读取继续串行。启动准入与锁内复核仍各自执行，不使用 mtime 或跨次缓存跳过哈希。

Workbench 的原构建输出 lib 受 Git 跟踪。首次准备在 `<job-root>/candidate/dsh-agent-workbench` 建立同提交的独立 build worktree，沿公开 `build:core` 真实编译，保留派生 lib 与 `static/category/index.html`、`static/mps/index.html`、`static/regional/index.html` 差异。候选声明登记干净 source 根；GEA 现有 sibling 类型路径和源码 profile 消费明确 prepared 根。`scripts/quality-workbench.mjs` 逐 Git blob 核除上述精确派生产物外的全部原源码、锁与同 source origin，再核冻结资产摘要。它不把 build tree 宣称 clean，也不放宽共享候选 checker。
