# 通用 Agent 工作台验收（2026-09-14）

结果：GEA 已接入独立工作台包，并与独立示例 Agent 一起在未修改的 npm DSH `0.1.5-rc.2` 上运行。DSH 源码不参与构建或启动，原生聊天、输入框、会话和工具运行仍由 DSH 提供。

## 交付

- `packages/agent-workbench`：布局适配、页面注册、按页面和业务实例关联会话、原生会话并排显示、拖动、窄屏排列、公开类型接口。
- `packages/workbench-example`：第二个独立客户端插件，用两个合同实例验证接入；默认部署不加载。
- GEA 使用工作台服务，登录后建立需求预测预设的会话，退出登录时清除页面关联。
- 启动器使用安装依赖中的 DSH CLI；禁用 `ui-layout` 并插入工作台插件。移除 fork 选择、构建产物探测和依赖链接脚本。
- 白名单安装包携带工作台包与公开类型，空目录按锁文件安装生产依赖。

## 验证

本次实际执行并通过：

| 检查 | 证据 |
| --- | --- |
| `npm run build` | 构建 GEA、工作台、示例客户端与工作台声明文件 |
| `npm run typecheck` | 所有源码及两个新包类型检查 |
| `node --test tests/workbench-controller.test.mjs tests/published-runtime.test.mjs tests/preset-modes.test.mjs tests/launch.test.mjs` | 11 项：实例隔离、并发合并、导航竞争、注销/卸载、显式关联优先、刷新恢复、失败处理、发布依赖、预设及启动参数 |
| `node --test tests/receipt.test.mjs`（与上述定向测试同批执行） | 2 项：标准 Session 落盘与重启恢复、存储故障后重试 |
| `node --test tests/workbench-boot.test.mjs tests/web.test.mjs tests/workbench-pages.test.mjs` | 3 项：发布版启动、原 GEA 操作、多 Agent 与实例切换、草稿隔离、原生输入、刷新恢复、窄屏和页面卸载 |
| `node --test scripts/package-smoke.test.mjs` | 空目录安装生产依赖，模拟 GEA 模型调用、原生输入、Session 持久化、重启后会话保留；无效 `DSH_SOURCE_DIR` 不影响启动 |
| `git diff --check` | 无空白错误 |

浏览器使用本机 Chrome，外部 GEA 与模型响应由测试 HTTPS 服务提供；未对真实业务执行写入。截图位于 `.runtime/workbench-evidence/desktop.png`、`.runtime/workbench-evidence/narrow.png`，不包含真实身份或业务数据。界面机械检查无报告项。

验收同时修正了测试关闭逻辑：被信号终止的子进程不再次等待已经发生的退出事件；安装目录清理前先停止拥有的测试服务。安装包浏览器用例改为当前界面的内测声明和原生输入流程。

## 使用范围

- 页面与会话关联只保存在当前浏览器标签页，支持刷新，不支持跨设备恢复。
- 布局代码在工作台包内维护；升级 DSH 仍需验证插槽和服务兼容性，当前固定 `0.1.5-rc.2`。
- 示例是接入验收页面，未连接合同业务系统。
- GEA 暂以整个工作台作为默认业务实例；后续具体计划/版本可通过 `open(pageId, instanceId)` 细分，不需要修改布局。
- 尚未发布独立 npm 包、合并分支或切换既有运行服务。原 GEA 工作目录与 DSH 工作目录保持干净。

## 后续 Agent 接入

在业务插件中注册自己的 `main` 页面和预设，通过工作台 `register`、`open` 和 `showConversation` 接入；不要复制聊天、输入框或全局导航。已有会话用显式 Session ID 关联。插件卸载撤销页面注册，业务身份失效时调用 `forget`。页面需要发送给模型的数据仍必须通过标准 Session 输入记录。
