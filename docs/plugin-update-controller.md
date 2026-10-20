# 单包更新 Host 合同

`src/host/plugin-update-controller.ts` 导出 `createPluginUpdateController` 与 `pluginUpdateProcessIdentity`。状态类型由 `src/shared/plugin-update-state.ts` 统一维护。04 负责 GEA 生命周期、认证路由、真实 Loader 读取与客户端观察的接线。

## 调用与归属

| 调用                                 | 行为                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `initialize()`                       | 读取私有回执及当前 profile，不等待自身 Fiber 在 apply 中变成 ACTIVE。中断事务与损坏回执阻断继续安装。  |
| `check(signal?)`                     | 查询签名源、取得官方锁内 baseline，并按完整当前组合规划单包更新。取消只影响本次查询。                  |
| `submit({packageName, planId})`      | 下载、重核 baseline/组合、保存完整恢复材料，再写入持久 accepted 回执。返回接受结果后继续由 Host 执行。 |
| `snapshot()` / `subscribe(listener)` | 读取/订阅同一操作投影。取消订阅或关闭页面不会取消安装。                                                |
| `reconcileRuntime()`                 | 用实际新 Node 进程、固定 startup Host 导出和当前受控 client 观察核对待重启结果。                       |
| `dispose()`                          | Host 卸载时取消、等待本次操作及已观察的受控进程组；不能证明全部写者停止时保留 unknown。                |

必需配置是 profile、具有真实部署来源的 `FixedCore`、私有 `runtimeDirectory`、签名 `source` 与 `readRuntimeProofs(processIdentity)`。不设默认 OSS 地址、凭据或 Core 身份。运行时直接使用公共 `withFileLock`、`runProfilePnpm` 和 `resolveBundleDir`。

`readRuntimeProofs` 必须读取现有 ACTIVE Host namespace 内的编译 literal stamp，并校验公共 callback 身份及实际解析路径。client 是经过认证、nonce/page/process/artifact 校验的受控观察，类型为 `kind: 'observed'`，不是 Host 独立认证的 ACTIVE Fiber。原始客户端 POST 不可直接强转为该类型。04 负责实际读取与边界解析。

首次读取若自身 Fiber 仍 loading，Host proof 保持未验证。后续安装前读取到 ACTIVE 后才固定；发生安装变更后不能用磁盘或新 import 升级旧 Host proof。进程身份采用 `node:perf_hooks` 的 `performance.timeOrigin` 与 pid，同一进程中的模块重载和控制器重建不会冒充重启。旧 browser 或缺失 client proof 保持 pending；新进程内错误 ACTIVE Host stamp 进入 unknown。

## 安装与恢复

操作只更新已在 profile manifest 注册的公司包。实际安装所有者必须来自该 profile 的 node_modules；installAnchor 阴影解析或外部公司包链接阻断安装。执行参数是 `add file:<verified archive> --save-exact --ignore-scripts --ignore-pnpmfile --config.auto-install-peers=false`，`activateNewBundles: false`。不触发 HMR、自动重启或生产写入。

同一官方 package.json 锁覆盖重核 baseline、完整恢复图、accepted 持久记录、公共 runner 和 postcheck。baseline 包含 manifest/lock、当前用户 patch/workspace、完整可达依赖图、内容摘要及外部链接摘要。恢复图复制 symlink 本身，不跟随复制外部目标，记录空间需求及来源；文件内容和目录项在 accepted 前 fsync。

成功 postcheck 核实际目标版本、原非图 manifest 字段、完整组合、每个 consumer 的实际 peer 解析，以及已验证 TGZ 文件内容。它只证明磁盘安装，随后进入 pending-restart。该阶段和 unknown 都阻断后续更新。

可达图从 profile 当前根包出发，沿每个实际 consumer 的依赖、可选依赖及 peer 解析继续遍历，以 realpath 去重。pnpm 虚拟上下文中的同级 node_modules 也属于该图；未被当前根包引用的旧 .pnpm 实例不参与判断。普通包及公司 peer 按 consumer 的真实上下文核版本；Core 提供的 SDK peer 按公共解析合同使用真实 CLI installAnchor，不能用 consumer 的 package.json 冒充安装锚。

当前进程所有权只支持受控 POSIX 进程组。Windows 在 check 和 submit 前均阻断，不能先写入依赖图再进入 unknown。投影保留 waiting-lock、snapshotting、installing、verifying 的真实阶段，公共 Core 合同与字典负责界面文案。

失败时先根据官方 run.json 的实际进程观察判断写者是否停止。必须观察到受控 POSIX 进程组、生存及退出，才允许恢复完整旧 node_modules 和原 package.json/pnpm-lock。无观察、无组进程、Core 的无组兼容修复、仍活着的后代或权限不足均保留 unknown。恢复失败和回执写入失败也保留 unknown，不盲目重装。

cordis.patch.yml 与 pnpm-workspace.yaml 只用于 baseline 观察，恢复保留它们的现值。若安装期间 package.json 非图字段改变，无法证明写入归属，保留 unknown 而不覆盖合法用户设置。Session、草稿、凭据和默认选择不属于安装事务。

私有操作目录保留 TGZ、日志、receipt.json、recovery/snapshot.json、完整旧图和包外 `RECOVERY.md` / `recovery-status.mjs`。独立状态脚本仅输出恢复证据，不执行恢复，也不把进程组不存在当作完整树停止证明。accepted 前持久回执先原子替换并 fsync，再更新 latest 指针；损坏材料不会被重置成可重试。

更新在 accepted 前按当前官方 `profile.home` 备份完整 `agent-plugins` 用户目录到 `recovery/user-data/agent-plugins`，包含个人 Agent、插件 Agent 的用户修改、MCP 配置及 Skill 正文、引用和脚本。备份复制链接本身，不复制外部来源；外部来源仍由原 owner 保全。备份前后内容不一致或空间不足时不运行安装。

新操作的 `userDataSha256` 绑定私有备份清单。安装结束及正常新进程确认完成前，均核原文件仍存在且内容保留；两个 Agent JSON 允许序列化排版变化，比较完整解析结果。新增文件允许保留。原文件丢失、内容变化、home 变化或备份损坏进入 unknown，保留现值和备份供核对，不自动覆盖并发用户修改。旧操作没有该字段时沿旧协议读取，不将其追认成已通过本项检查。

## 来源有效期与验收边界

source 的 `assertCurrentRelease` 集中判断签名批准有效期，过期清除可执行 map。下载前、完整备份后以及物理 runner 前重新检查，旧 plan 不能绕过批准过期。频道 revision/时间及版本摘要保留在 source 的独立信任回执中。

签名、HTTP 和来源读取失败使用 check-failed；Core 身份、依赖图或执行条件不满足使用 blocked。`src/shared/plugin-update-diagnostics.ts` 集中产生和解析安全事实：封闭错误种类、包名、所需范围、当前版本和 Core 版本/提交。原始路径、响应头、签名、凭据和 stderr 不进入公共 problem；client 不维护第二套错误字典。

`GEA_PLUGIN_UPDATE_SDK=<generated fixed SDK> pnpm test:plugin-updates` 使用真实临时 profile、真实 Node 子进程及官方 public operations。显式 SDK 与候选 operations、run-tree、atomic-write、profile 源文件必须符合固定 SHA。候选 SDK 尚未生成 lib 时，可以用源码一致的原固定 SDK 只读测试，产品模块不含该绝对路径。此检查不等于完整 Core build、Native/真实 Loader、实际 pnpm 安装、OSS 频道或生产验收。

控制器回归覆盖非空个人 Agent、插件用户修改、完整 Skill 引用文件的备份，以及安装期间和重启前丢失文件的拒绝。实际 pnpm/新进程与显式 desktop lane 同样检查这些文件及恢复副本；真实 Native 另须通过公开 Agent/Skill API 回读配置和引用内容，记录实际更新、旧新 PID、Host/client 装载及默认选择、Session 和草稿保全。

真实隔离布局 fixture 另外要求 `GEA_PLUGIN_UPDATE_PNPM=<pnpm 11.7.0 的 bin/pnpm.cjs>`，固定版本断言后用私有 store 与本地 TGZ 离线安装。它覆盖不兼容 transitive peer、兼容图与无关旧上下文、以及由显式只读 Core installation 提供 SDK 的普通 profile；该 lane 不访问正式 App profile 或 OSS。

当前实际 App pnpm 11.7.0 离线本地 TGZ 研究发现普通与 peer 上下文更新后旧实例及懒加载资产仍在，证据由总任务的 `pnpm-old-instance-probe-20261014/result.md` 与 receipt 文件提供。这只支持研究使用的精确命令和 layout，不保证其他管理器、prune/GC 或任意旧运行图完整可用。03 不增加保留旧安装实例的运行时机制。
