# 公司三包更新

Host 使用官方 profile 安装锁、`runProfilePnpm` 和 `resolveBundleDir`。配置与公开入口见 `src/host/plugin-update-controller.ts`，状态见 `src/shared/plugin-update-state.ts`。

## 安装与确认

客户端读取同一公司频道组合，校验下载包和 Core 支持范围，禁止降级与需要数据迁移的更新。发布预检负责官方组合的依赖兼容；客户端安装继续使用官方安装器的兼容检查。安装前只读取 profile 配置、锁及三个公司包的 manifest，不遍历依赖文件树或复制个人资源。

`check` 生成计划。`submit` 与 `submitBatch` 都按同一计划，将全部有变化的公司包交给一次官方 pnpm 安装。持锁后重核计划、实际安装来源与活动 Host，拒绝外部公司包链接、安装锚阴影和并发 writer。已接受的安装属于 Host，关闭详情或取消订阅不会取消安装。

安装禁用生命周期脚本、pnpmfile、自动 peer 安装和新 bundle 激活，沿用 profile 已有 store。成功后只核目标版本及 profile 字段，进入 `pending-restart`。不自动重启或 HMR。

新 Node 进程使用实际活动 Host 导出、当前受控 client 观察及安装目录确认完成。同一进程重建控制器、磁盘上的新版本、旧浏览器模块或缺失的 client 观察均不构成重启确认。进程身份由 pid 与 `performance.timeOrigin` 组成。client 观察仍经认证、nonce、页面、进程及模块来源校验，不接受客户端自报 ACTIVE。

## 失败与旧操作

安装失败沿用官方返回和失败处理，不复制或恢复完整 `node_modules`，也不承诺失败后所有包仍是原版本。停止写入后报告 `failed`，保留日志，允许重新检查；需要修复依赖时重新安装。不能确认写者已停止、结果无法读取或回执无法落盘时保留 `unknown`。

`dispose` 取消并等待本次受控进程。POSIX 使用已观察的进程组，Windows 使用原生 Job。旧 `unknown` 只有在新进程确认原写者停止后才继续核运行结果；仍有 writer 记录或进程时保持阻断。所有目标实际加载后可完成，确认运行的版本与目标不同则报告中断失败，允许重新检查。

新回执为 schema 2，保留目标、进程、日志和完成证明。schema 1 首次读取时在原操作目录保存 `receipt.legacy.json`，保留旧备份和失败材料。旧目录摘要和用户资料摘要不再参与重启确认。损坏回执继续阻断，不能当作没有操作。

个人 Agent、Skill、Session、草稿、凭据和默认选择由原模块维护。更新不读写个人资源；并发用户编辑不应阻止安装确认。profile 非安装字段的异常变化报告失败并保留现值。

## 验证

`test:plugin-updates` 使用显式 `GEA_PLUGIN_UPDATE_SDK` 和固定公开安装器源码，覆盖控制器、真实 pnpm、新进程 Host/client 接收和浏览器入口。它不代表用户设备、Native 或正式频道生效。Windows 原生 Job lane 使用 `tests/plugin-update-windows.native.mjs`；真实用户设备还须核安装前后版本、旧新进程和重启提示是否消失，并单独记录耗时。
