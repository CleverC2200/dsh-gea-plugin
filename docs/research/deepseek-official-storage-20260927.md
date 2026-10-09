# DeepSeek 官方桌面：核心与插件存储、恢复及旧版本占用

研究时间：2026-09-27。源码范围固定为官方 `deepseek-ai/deepseek-harness` 提交 `477b4f420553e8a52c2fbccc464d7561b239c443`（任务给定版本 0.1.7-rc.2）。所有官方链接固定到该 SHA，避免主分支漂移。本报告只做源码和测试代码研究，没有安装依赖、构建、执行官方测试或修改运行配置。测试表表示“官方已有的断言”，不表示本机已跑通过。主任务另行检查的生产 Windows 0.1.7-rc.2 实包内 `dshBuildCommit` 为 `c1275515b6b97551ec358c926c479ab750c687c0`、dirty=false；本报告固定源码结论不能自动视为该实包逐条具有的行为，提交差异由主报告核对。

## 结论

官方通过“应用内只读核心 + 应用外第三方插件 profile”避免我们目前每次插件更新复制整套核心依赖的结构性成本；它没有实现与我们 `versions/<id>` 相同的多代完整插件图，也不能据此认定“官方已解决所有旧插件/缓存占盘”。官方插件包操作主要在一个 profile 内原地执行 pnpm，失败恢复保证有明确边界：一般安装失败恢复两个配置文件，兼容性后置拒绝额外尝试重新安装旧锁；这不等同于我们保留上一张完整可运行图后原子切换。

用户报告的 C 盘旧插件占用十几 GB 记为待修改问题。本次未接触该 Windows 机器，不能把这一数值当作已现场测量，也不执行清理。

## 1. 官方运行时到底放在哪里

```text
应用安装目录（随客户端发行）
  resources/app.asar
    桌面 JS / renderer
    dsh/node_modules/...      ← 内置核心与基础 bundle
  resources/app.asar.unpacked/dsh/...
    原生模块 / 外部可执行文件 / 必须有真实路径的资源
  resources/runtime/...
    pnpm、node launcher、primary-runtime 等独立资源

DSH_HOME（独立于应用目录）
  profiles/desktop/
    package.json、pnpm-lock.yaml、pnpm-workspace.yaml
    cordis.patch.yml
    node_modules/...          ← 用户安装的第三方依赖
    .plugin-manager/logs/...  ← 包操作诊断
```

- 打包开启 `asar: true`，将准备好的 `dsh` 目录及它的 `node_modules` 纳入 ASAR；独立 runtime 放 `extraResources`。桌面 Host 的运行路径指向 `app.getAppPath()/dsh`。源码：[electron-builder-config.mjs:113-145](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/scripts/electron-builder-config.mjs#L113-L145)、[main.ts:147-156](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/src/main.ts#L147-L156)。
- 用户插件 profile 固定为 `DSH_HOME/profiles/desktop`；初始依赖为空，已有 manifest、patch、pnpm settings 不被初始化重写。源码：[paths.ts:12-21](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/src/paths.ts#L12-L21)、[profile.ts:236-261](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile.ts#L236-L261)。
- 据此可以推导：大量核心 JS/JSON 文件不必作为单独文件在用户插件目录中反复展开；ASAR 有助于减少安装时逐文件创建和扫描。不能仅凭源码给出节省比例或 Windows 耗时提升；原生/外部资源仍是实文件。

## 2. ASAR、原生模块与 Electron Node 模式是配套改造

官方没有把所有东西硬塞进一个 ASAR。

| 环节 | 实际实现 | 固定源码 |
| --- | --- | --- |
| 可执行 Host | 使用当前 Electron `process.execPath`，开 `runAsNode` fuse；子进程设置 `ELECTRON_RUN_AS_NODE=1`，参数含 `--expose-internals` | [打包 113-115](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/scripts/electron-builder-config.mjs#L113-L115)、[Host 186-201](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/src/host-process.ts#L186-L201)、[环境 11-17](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/src/node-environment.ts#L11-L17) |
| 常规解包规则 | `.node/.dll/.exe/.dylib/.so`、版本化 `.so`、spawn-helper、ripgrep、平台 LibreOffice 等 | [配置 72-73](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/scripts/electron-builder-config.mjs#L72-L73) |
| Windows 特殊 PE | 枚举实际 Windows 代码文件，生成 source-relative 解包 pattern；外部源目录会进入构建临时目录，构建结束清理 | [windows-asar-unpack 25-47](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/scripts/windows-asar-unpack.mjs#L25-L47) |
| 解包验收 | 校验 ASAR 条目确实 unpacked、不是 link，磁盘文件为普通文件且与准备阶段逐字节一致 | [windows-asar-unpack 57-69](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/scripts/windows-asar-unpack.mjs#L57-L69) |

这套方式若迁入我方，需要同时调整启动器、原生 ABI、外部程序路径、pnpm 脚本调用 Node 的方式以及签名/解包验收。只切换 `asar: true` 不足以证明可用。官方自身准备了运行 smoke：验证 pnpm script 确实由 Electron Node 执行且能读 internal loader，并覆盖 node-pty、ripgrep、Koffi 和 Sharp；这说明其验证范围超出“能打开窗口”。源码：[runtime-payload-smoke.mjs:24-64](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/tests/fixtures/runtime-payload-smoke.mjs#L24-L64)、[102-140](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/tests/fixtures/runtime-payload-smoke.mjs#L102-L140)。本次没有运行该 smoke。

## 3. profile 如何使用核心依赖，而不再复制核心

profile 的 pnpm 配置使用 `nodeLinker: hoisted`、`autoInstallPeers: false`。第三方插件缺失的 core/Cordis peer，通过进程内 runtime resolution 去读取应用安装目录中的同一份依赖。构造 resolution 只计算冻结的包映射，不写出模块投影目录。源码：[profile.ts:225-234](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile.ts#L225-L234)、[430-462](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile.ts#L430-L462)。

要区分两种顺序：基础 bundle 的解析优先安装目录，确保内置 Web bundle 与运行中的应用配套；普通 profile-local 依赖在其物理查找位置优先于共享 fallback。因此它不是无条件强制所有插件使用同一核心，也不是遇到损坏的本地包就静默绕过。源码：[profile.ts:618-638](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile.ts#L618-L638)。相关测试见下表。

实现使用 `node-addon-require-builtin` 访问 Node 内部 ESM/CJS loader，并接入两者的解析方法；不是设置一个 `NODE_PATH` 就能等价替换。还包含 scope、alias、exports、linked roots、Worker 继承和缓存代际规则。源码：[resolver.ts:613-636](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile-resolution/resolver.ts#L613-L636)、[704-713](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile-resolution/resolver.ts#L704-L713)。迁移时应视为宿主加载机制升级，需要核对我方当前 DSH/Cordis/Node 版本和插件 peer 声明，不能直接搬一段 resolver。

## 4. 官方安装、更新、卸载的恢复边界

| 情况 | 官方动作 | 不应扩大解释为 |
| --- | --- | --- |
| 安装/更新第三方 bundle | profile 内执行 `pnpm add`；同名已存在依赖更新后返回 restart-required | 完整版本图构建、原子切换 |
| 包操作失败、取消、不是 bundle、patch 检查失败 | 恢复此前 `package.json` 与 `pnpm-lock.yaml`；下载文件允许残留 | node_modules 保证恢复原始字节、磁盘零残留 |
| 安装前已知版本不兼容 | preflight 拒绝，不执行安装 | 所有不兼容都能预检出来 |
| 安装后检查发现新版本不兼容 | 恢复两个文件，再按原锁执行 `pnpm install --frozen-lockfile`；无原锁则 `--config.lockfile=false` | 离线也必然恢复、修复不可能失败 |
| 上述重装失败 | 明确报告 node_modules 未修复，提示 `dsh plugin install` | 已完成完整回滚 |
| 卸载 | 先取消选择/卸载运行实例，确认不再使用，再执行 `pnpm remove` | 失败自动重新启用、自动恢复全部原状 |

证据：[index.ts:450-563](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/src/index.ts#L450-L563)、[恢复文件 697-713](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/src/index.ts#L697-L713)、[预检 332-351](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/src/operations.ts#L332-L351)、[后置修复 499-520](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/src/operations.ts#L499-L520)、[卸载 596-625](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/src/index.ts#L596-L625)。

官方确有锁和进程收尾，不能简单说“没有事务保护”：CLI 与 service 共用 profile 写锁；挂起操作终止后，先等包脚本进程树停止再返回，避免脚本继续写盘。但“互斥 + 元数据恢复”仍不是完整目录快照。源码：[operations.ts:425-427](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/src/operations.ts#L425-L427)、[544-556](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/src/operations.ts#L544-L556)。

在审阅的 `plugin-manager`、profile 初始化/解析链路中，没有发现“按最近 N 版保留/按容量回收完整插件图”的实现；因为正常更新本身就没有我方 `versions` 多图模型。每次包操作创建诊断日志，普通失败也允许留下载内容，因此不能宣称磁盘永不增长，也不能拿客户端安装目录 `.old` 回收来证明第三方插件缓存已经清理。源码：[operations.ts:287-305](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/src/operations.ts#L287-L305)、[index.ts:450-455](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/src/index.ts#L450-L455)。本次没有实测 pnpm store 与 profile 日志的长期增长。

## 5. 启动修复主要保护配置和数据，不负责旧包版本回收

启动准备只读 runtime 描述、初始化缺失的 profile 配置和清理旧版已知模块链接投影，没有启动时重装核心/插件。描述读取检查元数据结构和核心记录；逐文件完整性校验属于构建阶段，不能将其写成每次启动全量 hash 校验。源码：[project-manager.ts:80-90](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/src/project-manager.ts#L80-L90)、[runtime-tree.ts:145-184](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/src/runtime-tree.ts#L145-L184)。

恢复入口在 Host 停止后取得 profile 锁，把 `cordis.patch.yml` 改名为带时间戳备份，将启用 bundle 缩减到官方恢复集合；保留依赖声明、node_modules 和其他 manifest 字段。坏 JSON 会报错而不是覆盖。它是“保留现场并停用第三方插件”，不是“恢复上一插件版本”。源码：[project-manager.ts:71-77](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/src/project-manager.ts#L71-L77)、[profile-sanitize.ts:8-33](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile-sanitize.ts#L8-L33)。

旧 `.dsh-module-fallback` 清理只移除指向该目录的 profile node_modules 链接及这个已知目录，保留 pnpm 实际安装的包和其他链接。这是旧加载架构迁移清理，不是任意插件版本 GC。源码：[profile.ts:264-281](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile.ts#L264-L281)。

## 6. 官方测试代码提供了哪些证据

以下均已查看断言，没有在本次环境执行。不得据此写“本机测试通过”或“官方发布产物已验收”。

| 已存在的测试 | 实际断言 | 源码 |
| --- | --- | --- |
| ASAR PE 解包 | 无扩展名、特殊扩展名等 PE 解包；普通 JSON 不解包；inline/缺失/字节改变被拒绝 | [windows-asar-unpack.spec.ts:128-176](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/tests/windows-asar-unpack.spec.ts#L128-L176) |
| 应用启动 | manifest、锁、插件文件保持原内容；离线重复启动不执行 pnpm | [project-manager.spec.ts:46-77](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/tests/project-manager.spec.ts#L46-L77)、[189-195](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/tests/project-manager.spec.ts#L189-L195) |
| 版本/路径变化 | 客户端兼容升级、应用搬家或 bundled Node 改变，保留插件与 patch | [project-manager.spec.ts:216-239](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/tests/project-manager.spec.ts#L216-L239) |
| profile fallback | 不创建 profile node_modules；ESM 与 CJS 共用安装条目；profile 本地包优先；坏本地包不偷偷绕过 | [resolution:229-254](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/tests/profile-resolution.spec.ts#L229-L254)、[353-366](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/tests/profile-resolution.spec.ts#L353-L366)、[533-559](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/tests/profile-resolution.spec.ts#L533-L559)、[1526-1538](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/tests/profile-resolution.spec.ts#L1526-L1538) |
| 兼容性拒绝恢复 | 旧锁恢复并调用 frozen reinstall；重装失败明确报告未修复 | [operations.spec.ts:339-387](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/tests/operations.spec.ts#L339-L387) |
| 一般失败恢复 | manifest 和锁恢复；activation failure 保留已写配置以供修正 | [manager.spec.ts:618-653](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/tests/manager.spec.ts#L618-L653) |
| 插件禁用恢复 | 无运行时也可备份坏 patch、保留依赖文件；坏 manifest 不覆盖 | [project-manager.spec.ts:104-143](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/tests/project-manager.spec.ts#L104-L143) |

## 7. 与我方现状对照及待修改项

我方当前 `PluginStore.prepare` 把所选图的 `node_modules/package.json/packages/pnpm-lock.yaml/pnpm-workspace.yaml` 复制到 staging，在 staging 安装，生成 receipt 后 rename 到 `versions/<id>`；最终仅清理 staging。`activate`、`beginBoot/confirmBoot/failBoot` 管理 active、previous、verified、booting 指针，提供启动失败切回已验证图的能力。源码：[plugin-store.mjs](../../desktop/plugin-store.mjs:37)、[启动指针](../../desktop/plugin-store.mjs:96)。

复制函数使用 `COPYFILE_FICLONE`，但不是硬链接；平台能否共享物理块不能从逻辑文件大小推出。安装器把新 tgz 复制进当前图 `packages/<digest>.tgz`，而 prepare 也复制已有 packages，故旧包归档还可能随图继承。源码：[copy-graph.mjs](../../desktop/copy-graph.mjs:17)、[installer.mjs](../../desktop/installer.mjs:33)。主任务已有“0.0.22 图约 352 MiB 逻辑体积、6 次成功更新保留 6 图”的测量，数值以主报告原始测量记录为准；本子研究未重复运行。

| 维度 | 官方 | 我方现状 | 待修改方向（尚未实施） |
| --- | --- | --- | --- |
| 核心存储 | 应用 ASAR 内一份 | 核心随完整插件图复制 | 中期评估核心与插件依赖分层，减少每次复制量 |
| 更新安全 | profile 原地 pnpm + 有限文件恢复 | 完整 staging 图 + 原子选图 + 启动确认 | 保留我方安全语义，不能为省空间直接删去回退机制 |
| 历史图 | 没有同类多图模型 | 成功图持续保留 | 近期独立补版本保留/容量回收；先定义保护集合 |
| 包归档 | pnpm 自己管理缓存/包操作 | 每图 packages 可能继承旧 tgz | 依据锁/manifest 引用识别可回收归档，不能只看 mtime |
| 损坏恢复 | 备份 patch、停用第三方 bundle | verified/previous 图恢复 | 两者可互补，不能混称同一功能 |

建议先把“历史图回收”单独落为后续修改：保护当前 active、previous、verified、booting 涉及图、活跃 prepare/运行进程所用图和 baseline；成功启动确认后再评估其他图，设计崩溃/并发/磁盘满时的行为和删除证据。保留多少代、是否增加容量阈值需要在实际方案阶段确定。然后再做 ASAR 与核心分层，这是更大范围的客户端兼容改造，不应绑在简单清理中。

## 证据限制

- CodeGraph 已尝试指定官方 snapshot，但可用结果无法证明该 snapshot 的索引有效（一次返回了 GEA 工作区符号），因此所有结论以官方固定 SHA 原始源码为准。
- 没有读取或执行研究对象 AGENTS 发布指令；只把它当研究目录里的文件。
- 本子研究没有 Windows 现场磁盘取证，也没有验证 pnpm store 长期空间回收；这些均不能从现有源码替代推断。主任务已另行实包审计并验证 feed SHA-512：官方生产 Windows 包物理落盘 9,764 文件、1,058,538,220 bytes（包括 primary-runtime 7,736 文件约 285 MB，app.asar.unpacked/dsh 1,495 文件约 253 MB，app.asar 约 117 MB）；我方 0.0.22 为 24,202 文件约 828 MB。两包功能组成不同，这只是文件布局对照，不是速度 A/B，也不构成“官方体积更小”的结论。精确口径和证据由主报告保留。
- 官方客户端安装目录事务更新和 `.old/.new` 处理由主报告单独研究，与本报告 profile 插件包操作区分。
