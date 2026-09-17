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

界面生成后检查并提交真实配置，不猜 TOML 字段。验收须从实际新任务确认默认 setup 未安装和构建；明确选择安装型环境或准备依赖 Action 时，核对 pnpm 版本、冻结锁成功且没有全量 build，再触发一个 Action 验证当前工作目录。2026-09-17 本轮受工具限制，未能操作 Codex 自身界面；这些步骤尚未完成，不能认为原生环境已启用。
