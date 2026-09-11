# 干净源码目录验收

代码基线为 `28854dc397dd8b5d5a35eadc90e402e378779bb6`。使用 `git archive HEAD` 导出已提交文件到新建临时空目录，不复制原目录的 node_modules、lib、配置或运行数据。依赖通过 npm-shrinkwrap.json 安装，DSH_SOURCE_DIR 指向已构建的兼容个人 fork。

以下命令依次退出 0：`npm ci --no-audit --no-fund`、`npm run build`、`npm run typecheck`、`node --test tests/receipt.test.mjs`。最后一项启动真实 DSH profile，模拟外部 GEA，验证单次快照提交、新进程恢复及存储失败后的显式重试。运行目录和各阶段日志路径记录在本机忽略提交的 `.runtime/source-acceptance-path.json`。

该证据补齐 Issue #1 的干净源码目录安装、构建和启动要求。它仍依赖明确声明的个人 DSH fork，不证明干净宿主部署、真实业务写入或升级回退；这些由 #8、#10 和 #16 验收。
