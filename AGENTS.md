# GEA 工程入口

先从项目 [项目开发导航](../../../../docs/agents/current-development.md) 和本票 `integration-set.json` 核同组三仓 checkout、提交与未提交改动，再读本仓 [README](README.md)。根同名仓、原公司壳与旧发行记录按 [文档索引](docs/index.md) 追溯。

修改身份、Consumer、额度、取消或业务执行时，读 [执行链](docs/execution-logic.md) 与 [能力声明](docs/capability-contract.md)。GEA Host 为唯一身份与凭据权威；页面和页面/Session 关联归 Workbench，资源及纯计算归 Manage，持久 Session 与草稿归 Core。凭据、失败、取消、部分和 unknown 按原执行合同保留，原业务规则和用户数据不因工程整理改变。

准备开发依赖与构建时读 [本地开发](docs/local-development.md)，实际工具链、scripts、exports 和锁以仓内配置为准。启动及组合切换读 [源码组合](docs/plugin-split-validation.md) 与 [窗口准入](docs/window-launch-admission.md)，输入检查不证明装载，也不产生运行授权。

普通三包交付读 [打包与接收](docs/package-delivery.md) 和 [安装协议](docs/install.md)。收尾前读 [交付核对](docs/delivery-check.md)，按原规格核完整目标、在途工作、预算、依赖及暂停；一致性、packaged、Host 接收与业务验收分别留证。自动工具不授予授权或自动接续。

只在本任务隔离 checkout 与自有输出工作。正式 GitLab、OSS、npm、频道、原同名仓和正式客户端保持保护；旧文档中的发行步骤不覆盖此边界。业务 Prompt/Skill、运行时字符串、schema、法律来源、用户 Session、草稿及原失败证据保持原归属。

普通三包交付从 [打包与接收入口](docs/package-delivery.md) 进入。以下约束由实际入口执行，阶段结论仍分别记录。

| 交付规则                                                              | 执行机制                                                                                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可安装三包的资源、完整官方预设和 SDK 实例须在新普通 profile 接收      | `delivery:reception` 串行官方安装与 Loader 观察；`plugin-reception/contract.mjs` 统一接受投影与回执绑定；`test:delivery:packages` 重放真实 APS/Sales 失败 |
| 打包与接收确定性检查须在独立 G checkout 执行，不能依赖邻仓或现成 Core | `test:delivery:packages` 自建 fixture Core 与发布输入；`.github/workflows/delivery-fixtures.yml` 自动执行同一命令                                         |

## 纠正规则与执行机制

| 仍需判断的规则                                             | 执行机制                                                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自动检查核对原回执一致性，业务验收另据对应证据判断         | `delivery:check` 对 failed/unknown 返回非零（底层CLI3）；`test:delivery` 重放r31真实预算矛盾。报告浏览使用 `delivery:report`，详见[交付核对](docs/delivery-check.md)。 |
| 收尾前按原规格确认完整目标范围；用户暂停和票据依赖分别保留 | `delivery:verify-goal` 只接受声明目标全部验证且无在途工作，未完成底层CLI返回4；`test:delivery`覆盖阶段done但有独立下一步、暂停和缺目标。工具不授予授权或自动接续。     |
| Window fixture 的 Core、三仓和历史证据从显式冻结输入读取，准备前完成核验 | `tests/fixtures/source-window-inputs.mjs` 复用候选检查；`test:fixture-inputs` 观察文件与进程副作用，现有 delivery fixture CI 执行同一命令；`test:window` 保留完整原行为门禁 |
| 迟到的失败、成功与回读视图只归原执行，持久化期间失去归属不能发布当前证据 | `PromptExecutionState` 私有持有输出 State、执行 lease 与 store；`test:prompt-execution` 在 Node 24 无 SDK/deps 下核单一归属并运行真实文件 IO 行为，接入 `delivery-fixtures`；公开 Host hooks 的 `tests/execution-convergence.test.mjs` 在已准备官方依赖的 checkout 覆盖旧错误与资源准入/回读。预算及 UI mask 仍由原 admission 状态管理。 |

