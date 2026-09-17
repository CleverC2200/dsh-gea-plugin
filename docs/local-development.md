# 本地依赖与按需构建

开发源码使用 package.json 中的精确 pnpm 版本。当前验证工具链为 Node 24.14.1、Corepack 0.34.6、pnpm 11.27.0；Node 24 兼容范围不等于所有补丁版本都已验证。

## 准备

```sh
corepack pnpm --version
corepack pnpm install --frozen-lockfile --prefer-offline
```

Corepack 需提前可用，不在项目 setup 中安装全局工具。上述命令可避开 PATH 中其他 pnpm 入口。已有依赖且相关输入没有变化，不必每次检查前重装；只读或文档任务不需要依赖时不安装。

每工作树保留独立 node_modules 和 lib，复用 pnpm store，不链接其他工作树可写目录。workspace 中的构建许可和固定工作台 Git override 仅用于本项目，不复制成全局设置。

## 构建入口

| 需要做什么 | 命令 |
|---|---|
| 开发时监听插件源码 | `corepack pnpm dev` |
| 只改 Host | `corepack pnpm build:host` |
| 只改外层客户端 | `corepack pnpm build:client` |
| 只改业务工作台 | `corepack pnpm build:workbench` |
| 构建插件，不带示例 | `corepack pnpm build:plugin` |
| 完整构建，含示例 | `corepack pnpm build` |
| 类型检查 | `corepack pnpm typecheck` |
| 验证目标隔离及 watch | `corepack pnpm test:build` |

watch 只编译，不启动应用；运行应用仍用 README 的 start 命令。不要并发运行写同一输出的构建/watch。一次性 build 仍会编译，没有新增持久化缓存；日常增量编译交给 esbuild watch/context。

打包前执行完整 build。`corepack pnpm package` 不代表已构建或已发布；`corepack pnpm test:package` 验证最终包的空目录 npm 安装。开发 pnpm 锁不替代 npm-shrinkwrap 或桌面安装器自身的锁及归档协议。

## Codex 原生 Local environments

优先用原生工作树、setup scripts 和 Actions，不添加第二套注册或编排工具。[OpenAI 官方文档](https://learn.chatgpt.com/docs/environments/local-environment)说明：通过应用设置生成项目根目录 .codex 下的环境配置，setup 在新工作树创建时执行，Actions 在集成终端执行。

在该项目 Local environments 设置中填写：

- 默认 Setup：`node --version` 和 `corepack --version`，仅检查工具。
- 开发环境可另选安装型 Setup：`corepack pnpm install --frozen-lockfile --prefer-offline`，只安装，不自动 build。由使用者明确选择，不自动猜任务意图。
- Action「准备依赖」：`corepack pnpm install --frozen-lockfile --prefer-offline`。
- Action「开发编译」：`corepack pnpm dev`。
- Action「类型检查」：`corepack pnpm typecheck`。
- Action「完整构建」：`corepack pnpm build`。
- Action「构建测试」：`corepack pnpm test:build`。

2026-09-17 用户已通过界面保存默认 setup 和「工具检查」Action，确认实际生成的字段为 `[[actions]]`、`name`、`icon`、`command`。本分支沿用该格式补齐上述 Actions；主目录中的用户配置仍保留原样，待 pnpm 改造与配置一起集成。清理脚本为空，不自动删除依赖或缓存。

命令行验证不等于应用内验收：仍须从实际新任务确认默认 setup 未安装和构建；点击「准备依赖」时核对当前工作目录、pnpm 版本和冻结锁成功且没有全量 build，再触发一个检查 Action。该配置没有声明安装型 setup，安装只在明确点击「准备依赖」时执行。开发编译为持续 watch，不要同时触发写相同输出的完整构建；先停止 watch。

## 可选的本地运行采样

GEA 试点提供两个额外 Action：「采样 Host 构建（macOS/Linux）」与「本地采样报告」。普通命令和上述普通 Actions 不采样，不增加后台服务。也可主动运行：

```sh
corepack pnpm observe --task build --source terminal --condition existing-layout
corepack pnpm observe:report
corepack pnpm test:observe
```

采样 CLI 只在 GEA、POSIX 环境使用；Windows 继续使用普通项目命令。来源/缓存条件是人工标签，默认 unknown，不自动推断。

JSONL 位于用户目录下 `.local/state/dev-environment-governance`，每次独立私有文件。记录白名单任务、时间/退出/取消、工具版本、锁摘要、Git HEAD/状态摘要和工作树路径摘要；不记录源码、业务内容、环境值、完整参数和日志。原终端输出不被存档，也不被这个工具脱敏。pnpm reused 仅表示依赖复用，不是构建缓存命中；未明确输出的指标为 null/unknown。

仅 `--sample-space` 会在开始/结束扫描本项目 node_modules、lib、.runtime/packages；不会扫描共享 store。APFS 的目录占用和文件系统剩余空间分别报告，不能直接当节省量。HEAD/状态摘要不是完整输入标识，报告的重复/重试只是候选，不能据此复用产物或跳过工作。

只轮转自身合法且已完成的记录（30 天/50 MiB），不删除未完成/未知/链接文件，因此不是目录硬配额。写入失败不中断原命令；SIGINT/SIGTERM 会转发给命令进程组，保留退出/取消语义。Node 启动及最后写入/轮转不含在单条记录的内部开销字段中；总开销需外部成对测量。没有自动上传、清理依赖或自动更新治理规则。
