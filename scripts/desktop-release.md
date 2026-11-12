# 桌面安装包与在线更新交付

Mac 和 Windows 构建只生成文件，不发布 OSS。正式交付统一使用 `release:desktop`，一次处理固定安装包和客户端内置的在线更新源。不能只上传 DMG / EXE 后宣称客户端发版完成。

```sh
# 读取成功的构建 artifact，核对最终文件、版本、源码及更新清单
corepack pnpm release:desktop --artifacts /absolute/downloaded-artifact --source-sha FULL_GEA_SHA

# 已获本次正式发行授权后，在同一发行进程中串行执行；凭据只从环境读取
corepack pnpm release:desktop --artifacts /absolute/downloaded-artifact --source-sha FULL_GEA_SHA --publish --output /absolute/new-publication-receipt.json
```

输入目录必须包含原始成功 `result.json` 及同次构建的完整更新文件。Mac 需要已签名、公证的 DMG、ZIP、ZIP blockmap 和 `nightly-mac.yml`；Windows 需要签名 EXE、EXE blockmap 和 `nightly.yml`。允许 artifact 保留原目录结构。不重新打包或修改已经发布的同版本文件。

发布器先核安装包的构建摘要、清单内所有载荷的大小与 SHA-512，再上传固定安装包和在线更新载荷。每个对象均须匿名完整读回并核对摘要，最后才更新清单并匿名回读。上传或下载校验失败时，旧清单保留；同名不同字节、清单降级和同版本变更均拒绝。发布前再次核对旧清单，发现其他发行者更新则停止。所有发行者须串行使用本入口；对象存储的普通 PUT 不提供跨发行者事务。

`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` 沿用本次获授权发行环境，不写入仓库或自动增加 GitHub secrets。写入仅限 `client-release/raw/<source>/desktop/` 及对应平台的 `client-release/electron/`。公开读取权限只设置在所发对象上，不改桶策略。旧载荷保留供差分更新使用。

## Hindsight 安装输入

公司三包仍是独立的更新组合；完整桌面另外必须携带 `@cleverc2200/dsh-personal-memory`。将该插件已发布的不可变归档加入 `input.seed.packages`，使用自己的 `name`、`version`、`url`、`sha256`，并以 `sourceSha` 固定其已合入源码。URL 与其他包一样使用 `plugin-release/packages/<sha256>/<name-version>.tgz`，不接受分支、可变链接或查询参数。

构建前缺少个人记忆归档或来源提交时立即失败。归档必须包含实际编译的 `lib/client.js`、设置入口和 Host / bundle 入口，并与本次 GEA peer 兼容。双端沿现有 company seed 安装和离线首装验证全部包；旧三包 seed 保持可读，已安装用户的设置、历史、禁用及卸载选择保留。个人记忆自动生成开关由现有插件与服务端管理，打包过程不启用它。

## 验收边界

`release-plan.json` 表示本次构建的完整更新文件通过校验，`published-and-anonymously-verified` 表示公网交付完成，此时 `updateAcceptance` 仍为 `pending-full-ui-regression`。每次双端客户端发版收尾须完成下列回归，再由同一发布入口核验回执。源码 CI、下载校验及脚本重开客户端均不代替真实界面自动重启。

### 每版双端完整更新回归

1. 固定本版完整签名产物和来源提交，分别记录 Mac、Windows 上一版实际分发版本。用它们的已安装客户端及已有配置、非空历史会话作为基线，保全原资料。个人正式资料须在当前授权内操作；没有可用设备或权限时保留未完成状态，继续完成不依赖它的工作。
2. 在旧版内置 Node 中运行 `desktop-update-data.mjs --home DSH_HOME --capture PRIVATE_SNAPSHOT`。Mac 使用 `ELECTRON_RUN_AS_NODE=1 APP_EXECUTABLE --expose-internals SCRIPT ...`；Windows 用 `ProcessStartInfo` 设置同一环境变量并等待进程退出、捕获退出码。快照含原配置和完整会话，只保存在私有目录，不能上传或提交。
3. 正常打开旧版，通过真实产品更新入口检查、下载并点击安装重启；已自动下载就绪时从真实待重启入口开始，记录下载来源和签名验证。正式频道发布前可验证受控候选源，但须与待发布清单及载荷逐字节一致，正式频道发布后仍核真实来源与版本。手动操作或获授权的界面自动化均可，保留私有界面及进程观察证据。
4. 由原生更新流程自动拉起新版。观察旧进程退出及新版正常窗口，保持默认重启参数和原更新器；升级后由测试脚本、快捷方式或终端启动新版的结果不计入本项。Windows 记录自动新进程的 `--updated`，Mac 观察原生替换后的新窗口。随后确认版本及“已是最新版”、原账号恢复和工作台正常打开，核平台签名及安装位置。
5. 用新版内置 Node 运行同一工具 `--home DSH_HOME --before PRIVATE_SNAPSHOT --output NEW_DATA_RECEIPT`。它核已安装 seed 的实际 Core 文件，逐项比较用户配置、每个原会话头及原事件，允许追加事件，仅放行与已安装 seed 一致的 Core 完整性证明刷新。空资料不能替代保留回归。原始失败保持私有，成功回执只含版本、数量与核对结果。清理本轮临时任务及调试端口，保留必要恢复材料并让新版正常打开。
6. 按下面的回执合同汇总两端界面观察及数据回执，运行发布收尾核验。通过后才在 Release、更新说明及交付记录中写“完整更新验收通过”。本次 [双端实际结果](../docs/collaboration/changes/2026/11/12/desktop-upgrade-recovery.md)作为历史案例，不能替代下一版回归。

```sh
corepack pnpm release:desktop --verify-update --source-sha FULL_GEA_SHA \
  --mac-artifacts /absolute/mac-artifact --windows-artifacts /absolute/windows-artifact \
  --acceptance /absolute/full-ui-acceptance.json --output /absolute/new-acceptance-result.json
```

收尾核验只读本次原始构建产物和回执，不发布、安装或启动客户端。它拒绝缺平台、来源或产物摘要不符、同版重开冒充升级、缺界面步骤、脚本控制重开、配置或会话未通过等输入。退出零且输出 `full-ui-update-regression-passed` 才表示回执完整；界面与进程观察仍由实际验收者负责，布尔字段本身不证明已经操作设备。只获单平台构建或上传授权时保持原阶段边界，不能写成双端发版回归完成。

### 完整界面回执合同

顶层为 `schema: 1`、`status: "passed"`、本次 `version`、`sourceSha` 和 `platforms`。`platforms` 必须分别含 `mac-arm64`、`win-x64`，每项记录：

| 字段                                                                                                                    | 来源与通过条件                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `fromVersion`、`toVersion`                                                                                              | 实际旧版和新版，前者须早于本次版本                                                                                            |
| `installerSha256`、`feedSha256`                                                                                         | 同次构建 DMG / EXE 与更新清单摘要，核验器与原始产物比对                                                                       |
| `signatureVerified`                                                                                                     | 已安装正式应用验签通过，值为 `true`                                                                                           |
| `ui.entry`                                                                                                              | 实际入口为 `check-download` 或 `restart-ready`                                                                                |
| `ui.downloadVerified`、`installAndRestartInvoked`、`normalSuccessorWindow`、`accountResumed`、`currentVersionAndLatest` | 均为 `ui` 内字段，由实际观察逐项确认 `true`                                                                                   |
| `relaunch`                                                                                                              | `method: "native-updater"`、`manualSuccessorLaunch: false`、`flagsUnmodified: true`、`updaterOrCoordinatorIntercepted: false` |
| `data`                                                                                                                  | 原样嵌入新版 `desktop-update-data.mjs` 成功回执，旧版、新版须匹配本项                                                         |

快照、用户配置值、会话内容、身份标识和原始截图保持私有。公开回执与发布说明仅保存上述汇总及必要来源；CI 运行核验器与数据比较的拒绝回归，不使用个人资料，也不把夹具测试标成实机验收。
