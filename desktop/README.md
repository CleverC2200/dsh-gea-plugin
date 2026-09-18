# GEA Electron 桌面

桌面壳固定 Electron 44.0.0、官方 DSH 0.1.5-rc.2、Node.js 24.14.1 和安装工具 pnpm 11.27.0。只交付 macOS Apple Silicon DMG 与 Windows x64 NSIS。安装包不携带维护者凭据。

## 首次启动

等待页区分打开工作台、应用插件更新、手动重启与恢复旧版本，不再把更新描述为首次登录。轻量等待动画不显示虚构进度；系统启用“减少动态效果”时保持静态。日志入口折叠在“等待较久？”中，失败时直接展开问题详情。扫码登录页提供二维码准备、待扫描、过期及失败状态和操作提示；动画与文案不改变凭据恢复、登录请求或插件切换逻辑。

公司正式/测试地址与模型 ID 由 desktop/company.config.json 随发行版本提供，首次启动自动生成配置并直接进入扫码登录。不向业务用户展示连接表单，也没有“连接设置”菜单。已有配置保持原样，不覆盖用户会话。发行配置只含部署参数，不含凭据。

已有登录信息在后端启动前通过系统安全存储解密；系统授权提示的等待时间不计入后端本机通信的 5 秒超时。读取失败时显示启动错误并保留加密文件。指定 `GEA_ELECTRON_EXECUTABLE` 和 `GEA_DESKTOP_PAYLOAD` 运行 `node --test desktop/slow-login.test.mjs`，验证系统凭据读取耗时 8 秒时仍能恢复登录并打开工作台。

## 独立插件版本

首次从 payload 基线启动。菜单“插件版本 → 准备本地插件包”接收已构建 tgz，复制基线的代码与锁到用户目录暂存区，通过官方 `dsh plugin` 安装到该区。pnpm 由 payload/tools 提供，不调用同事机器上的开发工具。官方依赖逐项固定，安装后核对版本与公司插件的共享 Cordis 解析。

准备完成不会改变当前进程。组合存于 userData/plugins/versions，version.json 记录实际版本、依赖和锁校验值；“切换已准备版本并重启”串行停止当前后端、原子写选择、启动新组合。Electron 与内置 payload 不被修改。版本目录包含独立解析的完整图，避免官方 DSH 安装优先解析规则导致仍加载内置旧插件。

配置在 userData/gea.config.json，会话、设置与工作区在 userData/data。切换只更新 profile 的受管插件链接与清单，保留数据。DSH_GEA_DESKTOP_DATA 可指定隔离验收目录。普通 node_modules 目录不会被自动覆盖。准备区只复制包、代码、锁，不复制连接配置、账号或会话。

#37 只承诺手动选择已准备版本，不将自动回退列为已验收能力。不得把登录失败或外部 GEA 网络不可用作为后端启动失败。

## 构建和验证

Windows 安装耗时专项使用 [一次运行采集说明](INSTALL-DIAGNOSTICS-README.md)。诊断包必须携带与 `diagnostic-package.json` 摘要一致的完整 EXE，不能用普通安装包替换。该包仅供专项试用，不自动推进桌面频道。

诊断构建用 `prepare-installer-diagnostics.mjs <app-builder-lib目录> <新模板目录>` 给固定 26.15.3 模板加阶段日志，再用 `build-diagnostic-installer.cjs <node_modules目录> <独立桌面导出目录> <win-unpacked目录> <新模板目录> <输出目录>` 复用同一 payload；设置 `GEA_DESKTOP_TARGET=win`、`GEA_INSTALL_TIMING_LOG=1` 及 `GEA_DESKTOP_PAYLOAD_ROOT`。导出目录中的 `build/installer-timing.nsh` 必须来自本次源码。不修改共享构建缓存，不更换默认 7z 算法。`installer-timing-probe.nsi` 在 Windows 上验证日志追加、寄存器/栈及错误标记不受日志成功或失败影响；云端 clean/upgrade 验证不能冒充 Windows 10/11 实机性能验收。

常规交付按本次改动选择定向检查、构建及包内容/摘要校验。启动时长、业务接口和资源同步属于问题专项验收；已通过后，仅在再次出现相关问题或明确要求时复查，不作为每次构建、发布、提交或合并的前置条件。下文的启动、同步和更新脚本供相应问题排查使用。

同一组源码、依赖锁、平台、公司配置和资源快照只准备一份 payload；已验证的最终包直接用于发布和频道提升，不因提交、合并或切换频道重新打包。只有输入改变才重建受影响的平台，Mac 与 Windows 可以并行构建，原生依赖分别准备。保留依赖下载缓存、最终包及摘要/构建记录；发行完成后清理本次未被进程使用的 raw/compact、解包应用和隔离验收副本，保留用户数据及正在使用的目录。

桌面壳应从固定源码提交的 `desktop/` 独立导出目录打包，不能在 pnpm 工作区中直接运行 `electron-builder --projectDir desktop`：构建器可能把父工作区的生产依赖重复装进 `app.asar`。导出目录不得包含父工作区的 manifest 或 node_modules；通过现有 `GEA_DESKTOP_PAYLOAD_ROOT` 提供已验证运行依赖。检查 app.asar 只包含配置中的壳文件，不含额外 node_modules。

浏览器注册脚本以 IIFE 独立作用域压缩，防止 DSH 合并脚本时不同包的编译器辅助变量互相覆盖。修改压缩流程后运行 `node --test desktop/optimize-client-artifacts.test.mjs`，再验证真实桌面页面加载与更新。

Windows 工作流 `Check Windows installer` 仅通过手动运行触发，必须指定已有发行标签。默认只下载、校验并安装该包，不下载诊断插件、不安装浏览器驱动，也不启动应用。排查启动或同步问题时才选择 `run_diagnostics`，复用现有专项脚本；该任务不因 PR 标签或每次构建自动执行。

公司发行必须加载 `dsh-agent-manage`，不能用第三方 `dsh-agent-plugins-market` 替代：后者能加载套件 Skills，但不包含登录后发现 GEA MCP 工具的集成。`installCompanyManage` 在新暂存图中移除旧依赖并安装公司包，保留原运行图以供回退。`compact-payload.py` 在复制前执行公司插件门禁，缺少公司入口或 MCP 模块时拒绝打包。

运行 `GEA_MANAGE_GRAPH=<payload或外置版本目录> node --test desktop/gea-mcp-bundle.test.mjs`，用实际分发插件和本地模拟网关验证登录后发现工具、退出后移除连接；此测试不访问生产业务数据。Consumer 授权问题使用实际登录用户做针对性诊断。

使用 electron-builder 26.15.3，`GEA_DESKTOP_PAYLOAD_ROOT` 指向新构建根，包含 mac/payload、win/payload。各 payload 必须包含相应平台 Node、生产依赖、标准发行包、pnpm 11.27.0 工具与 runtime-start.mjs 的 start.mjs 副本、onboarding.mjs。不能把 Mac 原生模块复用到 Windows。

`npm run test:desktop` 运行不依赖安装包、Electron 或外部频道的快速桌面回归。`npm run test:desktop:electron` 使用 `GEA_ELECTRON_EXECUTABLE` 和 `GEA_DESKTOP_PAYLOAD` 运行真实 Electron 启动、恢复、凭据和首次业务页面回归。指定 `GEA_DESKTOP_TEST_GRAPH` 运行 desktop/runtime-graph.test.mjs 验证外置启动；指定 `GEA_DESKTOP_BASELINE`、`GEA_DESKTOP_NEXT`、`GEA_EXPECTED_BASELINE_VERSION` 和 `GEA_EXPECTED_NEXT_VERSION` 运行 desktop/version-switch.test.mjs 验证实际页面版本切换。

Windows 路径使用 file URL 动态导入、junction 与带引号的固定工具路径；在 Mac 的交叉检查不等于真实 Windows 验收。安装方式变化或出现安装问题时，针对受影响平台验收；其他交付复用适用的安装记录并说明签名状态。

`time-command.py` 记录打包起止时间与耗时。当前支持插件更新的发行包使用 `compact-payload.py <mac|win> <source> <new-destination>` 精简副本；仅移除依赖源码映射、原生调试符号、其他平台的 node-pty 预编译文件及 Node 开发头文件/文档。同时补齐 Mac node-pty 终端辅助程序的执行权限，并在报告中记录。保留全部运行代码、锁文件和插件归档，逐文件校验其余内容未变，并生成 `compact-report.json`。构建时将 `GEA_DESKTOP_PAYLOAD_ROOT` 指向精简副本根目录。旧 `trim-payload.py` 会移除归档和锁，不适用于当前更新流程。不得覆盖已有产物或运行中的数据目录。

## 失败恢复与登录保留（#38）

启动先记 booting，只有本地页面和不依赖 GEA 网络的状态接口健康后才确认为 verified。未确认启动被中断或新后端失败，恢复上一已验证组合；本地页面、探测均有限时，未登录不会触发回退。准备失败只清理本次目录；进程崩溃后的遗留暂存目录保留，避免误删仍存活的安装子进程文件，重试使用新目录。

GEA 登录由 Electron safeStorage 使用操作系统加密保存为 userData/login.encrypted，经带随机令牌的私有回环接口交给自有后端。网页不能读取该接口；无系统加密能力时不降级到明文。后端停止不清除保存状态，显式退出登录或凭据过期会清除；过期令牌仍须重新扫码。登录文件与会话数据均不进入版本目录。

当前数据 schema 为 1。发行包声明其他 desktopDataSchema 时拒绝准备，已有选择声明其他 schema 时拒绝启动/降级并保留数据，必须恢复兼容应用。没有实施跨 schema 数据迁移；不得通过删除用户数据来绕过不兼容。相同 schema 的版本切换不迁移配置、会话和工作区。

定向恢复验证包含真实 Electron 新版本启动失败回退、系统加密身份重启保留/退出清除，以及真实安装进程被杀后的重试。Windows 对应行为仍需真机验收。

## macOS 内部分发与签名验收

不可将 `mac.identity` 设置为 `null` 后直接分发：Electron 改名和重新封装后，旧的链接器临时签名不具备完整的资源封装，可能被下载后的 Gatekeeper 判定为损坏。默认使用 `-` 对最终应用重新做 ad-hoc 签名，并在 `afterSign` 执行 `codesign --verify --deep --strict`，失败立即阻止生成安装包。

默认产物仅适合内部试用。ad-hoc 签名只能验证内容完整性，不代表 Apple 认可的开发者身份或公证，不保证通过 Gatekeeper。首次打开可能需要用户在系统设置“隐私与安全性”中按应用单独批准；不得要求关闭全局 Gatekeeper。

正式对外分发需配置 `GEA_MAC_SIGNING_IDENTITY` 为 Developer ID Application 身份、`GEA_MAC_NOTARIZE=1` 及构建工具支持的安全公证凭据。该模式启用 hardened runtime、公证并要求 Gatekeeper 评估通过。不得将私钥、密码或公证凭据写入仓库或安装包。最终验收应包含通过下载方式获取安装包的新机器首次打开；本机直接执行应用不替代该验收。

`setup.html`、`setup.js` 和 `preload.cjs` 保留旧连接表单原型，当前桌面入口不加载这些文件。发行版沿用上述公司默认配置与扫码登录流程。

## 业务发行 0.0.7

首次启动预置公司资源目录中的两个套件及 HTTPS 归档源，资源列表离线可见；业务用户无需输入仓库地址、安装 Git 或提供 GitHub 凭据。套件由用户在资源管理中选择安装和启用，GEA 扫码登录及原有业务预设开箱可用。首次复制后不会用随包旧目录覆盖用户已同步的资源。升级时仅将旧版公司默认 Git 主分支来源迁移为归档来源，保留已安装套件、启用状态与自定义来源；手动接管的目录和自选分支保持原样。

桌面使用下述 GitLab 发行频道；`stable.json` 和 `test.json` 明确包含当前桌面版本及插件兼容版本。检查更新不阻塞打开窗口或登录页；准备更新不影响当前运行版本，只有明确重启才切换。

打包先用 `prepare-payload.py <mac|win> <archives> <node-distribution> <new-payload>` 从每个包唯一版本的归档安装相应平台依赖，记录归档摘要。公司运行包只安装所需的 DSH、GEA、共享工作台、插件市场、Agent Manage 和 visualize 依赖，不安装未启用的第三方 UI 全家桶。随后在新目录运行 `compact-payload.py`，再运行 `node desktop/optimize-client-artifacts.mjs <compact-payload> <esbuild-module>`：压缩浏览器注册脚本和 GEA 业务页面，生成无源文本的预计算源码映射，减少每次启动合并模块的 CPU 开销；官方 Host 运行代码和插件版本保持不变。产物中的 `client-artifacts.json` 记录编译器版本及前后摘要。

准备脚本通过 Agent Manage 的 `archiveInstall` 从公司源下载资源到 `payload/resources/company-agent-suites`，记录归档摘要；这一步只在构建机联网，客户端启动不下载。Mac 和 Windows 使用相同的纯文本资源快照，各自安装平台依赖。两份最终 payload 均检查平台原生模块，再调用 electron-builder。MCP、客户端启动与同步验证按上述问题专项规则运行；报告分别注明本次执行和复用的证据，不将交叉构建描述为真机验收。

Windows 保留 NSIS 默认 7z 安装方式，通过减少依赖文件和包体缩短安装过程。资源同步使用 Agent Manage 0.6.3-company.4，修复 Windows 解压路径分隔符检查和大归档并发写入问题。

Windows NSIS 构建固定使用 `ELECTRON_BUILDER_7Z_FILTER=BCJ`，避免 electron-builder 26.15.x 生成的 BCJ2 归档与安装时 Nsis7z 解码器不兼容；同时启用 `nsis.differentialPackage=true`，供更新器减少差分下载。该设置不能消除首次安装的本地逐文件复制耗时，也不替代安装后文件完整性验收。

Electron 内置语言包只保留 `en-US`、简体中文和繁体中文变体，避免把不使用的 locale 文件复制进 Windows 安装器；业务插件自己的多语言资源不受此白名单影响。

Windows 签名默认关闭，仅用于本机内测。正式或 Windows 真机验收构建使用证书环境变量，不把证书和密码提交到仓库：`WIN_CSC_LINK=/secure/path/gea.pfx WIN_CSC_KEY_PASSWORD=... GEA_WIN_REQUIRE_SIGNING=1`。也可使用 electron-builder 支持的 `CSC_LINK`/`CSC_KEY_PASSWORD`。开启强制模式后没有证书会直接失败；证书的 Subject/Publisher 必须与 AppX 配置中的 `GEA_MSIX_PUBLISHER` 一致。证书密码只通过 CI Secret、Windows 凭据管理器或临时环境变量注入，构建结束后清除。

仅供 Windows 10/11 内部验收时，可在 PowerShell 运行 `desktop/create-windows-test-certificate.ps1` 生成自签名测试证书。脚本会把证书加入当前用户的 `TrustedPeople`，仅该用户/机器信任；不要把生成的目录、密码或证书提交到 Git。自签名证书不能用于正式发布或替代公开信任的公司证书。

MSIX 只作为 Windows 10/11 验证路线，不进入现有正式频道。当前 electron-builder 26.15.3 的实现入口名是 `appx`（生成 MSIX/AppX 包），不是 `msix`。使用 `GEA_DESKTOP_TARGET=win GEA_MSIX_PUBLISHER='CN=实际签名发布者' electron-builder --config desktop/electron-builder-msix.cjs` 构建；必须提供真实签名发布者，未签名的试验包不能视为安装或更新验收。重点验证用户数据目录、原生 Node 模块、快捷方式/协议、首次安装和覆盖更新耗时。MSIX 的差分更新依赖 Windows 的 AppxBlockMap，和 NSIS 的 differentialPackage 不是同一机制。

插件更新以最多 32 个文件复制任务准备独立暂存目录，支持时使用文件系统写时复制，不共享可写硬链接。常规更新只执行一次 pnpm add；仅遇到存储路径或虚拟目录布局不兼容时，执行 pnpm install 修复后重试。其他失败直接返回，不重复安装。取消更新会等待正在进行的文件复制结束再清理暂存目录。

更新状态中的 timings.downloadMs 和 timings.prepareMs 分别记录下载校验与本地准备耗时，便于定位慢在哪一步；不把本地安装时间归为网络下载。

`GEA_DESKTOP_PAYLOAD=<payload> GEA_PLUGIN_ARTIFACT=<GEA插件.tgz> GEA_EXPECTED_PLUGIN_VERSION=<版本> node --test desktop/installer-portability.test.mjs` 在复制的依赖图中模拟另一台机器的存储路径和目录长度，执行真实 pnpm 安装并检查当前选择与业务配置不变。

额外指定 `GEA_PREVIOUS_PLUGIN_ARTIFACT=<较早GEA插件.tgz>` 时，同一测试还执行连续两轮真实安装及版本目录搬迁，断言没有因虚拟目录路径变化重建依赖，且未变核心文件保持原 inode 和字节。Mac 上仅模拟 Windows 的绝对路径元数据，不能替代 Windows 实机运行。

Windows payload 准备显式使用 `virtualStoreDirMaxLength: 60`，Mac 使用 120，安装器使用相同目标参数。仅对已知 hoisted/layout 5 图内部的虚拟目录记录做相对路径转换，在复制后及安装后各处理一次；真实 store、长度或其他布局不兼容仍保留 pnpm 重建兜底。旧 Windows 图可能需要一次布局迁移，不保证首次升级完全免重建。

准备插件后，桌面逐项核对浏览器源文件摘要；仅当内容与随包编译记录一致时复用压缩文件及源码映射，保持重复启动性能。更新后内容不同的插件使用新文件，不被旧优化产物覆盖。
## GitLab 更新渠道

`release-sources.json` 改为公司 GitLab 12 的公开发行库 raw JSON，正式/测试频道分别读取
`http://100.100.6.191:20656/chenyonghao/dsh-plugin-releases/raw/main/channels/stable.json`
和 `test.json`。下载不需要 GitLab 登录或 `GEA_RELEASE_TOKEN`，但网络必须能到达该地址。
源码库保持私有。当前服务仅提供 HTTP；需要部署 HTTPS 才能提供传输身份认证。

引导版 baseline 必须包含 `dsh-plugin@1.4.3-company.7`。更新协议从 baseline 加载，
因此升级桌面后，即使用户仍选择旧插件组合，也能读取 GitLab 并更新。旧的 0.0.5
安装包仍内置 GitHub 地址，不能通过修改服务器清单自动更换桌面内的渠道地址。
0.0.7 构建 macOS Apple Silicon 和 Windows x64 安装包，包含相同的 GitLab 更新配置。

可复验脚本：

- `GEA_GITLAB_BASELINE=<旧payload> GEA_GITLAB_RELEASE_MODULE=<新Hub的lib/services/release-channel.js> node desktop/gitlab-update-smoke.mjs`：免登录读取两个真实 GitLab 频道和全部包，校验摘要，通过官方 DSH/pnpm 更新隔离插件组合，并确认再次检查无更新。
- `GEA_GITLAB_BASELINE=<旧payload> node desktop/gitlab-runtime-smoke.mjs <上一脚本result.json>`：用实际新组合启动 DSH，验证软件更新页面与插件加载状态。
- `GEA_GITLAB_BASELINE=<旧payload> GEA_GITLAB_ELECTRON=<打包后的应用可执行文件> GEA_GITLAB_FROM=<旧Hub版本> GEA_GITLAB_TO=<新Hub版本> node desktop/gitlab-electron-smoke.mjs`：真实桌面 UI 下载、重启与版本切换；仅 GEA 登录使用本地模拟服务，发行下载与安装均为真实操作。

以上脚本使用自己的临时数据目录并关闭自己启动的进程，不操作用户的日常应用数据。

Windows 包验收先记录 GitLab 网络可达性。能访问公司网络时执行在线检查、下载和重启；公共 CI 无法访问内网时，通过应用原有的本地插件菜单安装与 GitLab 摘要一致的归档并切换版本，报告单独标记 `local-verified-archive`，不能据此声称 Windows 已完成内网下载验证。Mac 验收直接读取真实 GitLab 频道。

## 启动修复 0.0.8

本版包含系统凭据授权等待修复，以及客户端组合脚本的换行计数优化。`prepare-payload.py` 使用 pnpm 的 `patchedDependencies` 应用 `patches/client-modules-newline-scan.patch`；官方归档保持原始字节，补丁和锁随桌面版本固定。插件安装保留补丁声明，重建依赖后仍使用相同实现。上游源码对应 deepseek-harness PR #10。

Mac 本机构建对照中，再次启动中位耗时由 2.875 秒降至 2.105 秒；此数值不代表下载安装后的首次启动或 Windows 耗时。Mac 默认仍为 ad-hoc 内测签名，正式分发需 Developer ID 签名与 Apple 公证。


## 插件更新耗时诊断

`GEA_DESKTOP_PAYLOAD=<已验证payload> GEA_ELECTRON_EXECUTABLE=<开发版Electron> GEA_UPDATE_FROM=<基线GEA版本> GEA_UPDATE_TO=<测试频道GEA版本> npm run test:desktop:update-channel` 使用隔离数据和模拟登录，通过真实测试频道下载、安装、重启，检查头像、登录、工作区保留及不再提示同一更新，并输出阶段耗时。默认验证单个 GEA 插件更新；增加 `GEA_UPDATE_SCOPE=all` 时验证批量准备与一次重启。需已安装项目开发依赖、构建插件。该脚本保留临时 result.json 供核查，不操作日常用户目录。

2026-09-15 macOS arm64 同一外置插件组合、同一 0.0.10 安装包对比：原流程复制 15.23 秒、安装 4.01 秒，总计 19.25 秒；优化流程复制 4.88 秒、安装 2.30 秒，总计 7.20 秒。这里不包含重启时间；耗时取决于磁盘、缓存及依赖规模，不是性能保证。Windows 尚未实测。

### 插件中心下载桌面安装包

插件中心「软件更新」中的桌面客户端下载由 Electron 主进程处理。Hub 只发送检查、下载、取消、打开四个动作；不会接收主进程凭据，也不能指定下载 URL 或本地文件路径。

- `desktop-release-sources.json` 指向发行库 `channels/desktop-stable.json` 和 `desktop-test.json`。客户端默认检查正式频道。
- 清单 schema 为 1，包含频道、版本、中英文说明及平台产物的 URL、字节数、SHA-256。产物必须位于同一发行库的完整提交 SHA 路径；禁止跳转。
- 支持 macOS arm64 DMG 和 Windows x64 EXE。边下载边写入用户数据目录 `desktop-downloads`，取消或失败清理临时文件；大小和摘要一致才允许打开。点击「打开安装包」时再次校验。
- 下载不重启应用；安装需用户点击并按系统安装器操作。旧桌面缺少这组接口时，Hub 显示升级桌面的提示。
- 首次启用需要发布包含这些模块的新桌面安装包，同时发布 Hub 和桌面频道清单。后续桌面发行只需更新清单及不可变产物，不把安装包塞进插件包。

针对性测试：`node --test desktop/client-installer.test.mjs`。

### 批量插件更新

「全部下载」会下载并校验当前频道中的全部待更新插件，在同一个暂存目录中通过一次 DSH/pnpm 安装准备。全部版本核对通过后才允许重启，一次切换整组插件；下载、安装失败或取消时保持当前组合。准备过程中显示已下载数量，可继续使用当前工作台。旧桌面仍可逐项更新，新桌面通过 batchPrepare 能力标记启用批量按钮。

## 核心升级 0.0.10

本版固定 DSH 同步提交 `62803991def588844cf9d12902c9df2e669097b1`（官方 `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` 加本地换行扫描优化）。`prepare-core-archives.py` 将已构建归档的包版本及内部依赖统一标记为 `0.1.6-alpha.1-company.1`，记录来源，不向 npm 发布或覆盖官方版本。安装器保留随包 `file:packages/` 固定归档，插件更新不会替换核心字节。

新桌面的插件频道为 `channels/dsh-0.1.6-stable.json` 和 `channels/dsh-0.1.6-test.json`；旧桌面继续使用原频道。GEA 0.0.14、工作台 0.1.1、Hub 1.4.3-company.8 保留原发行归档，Agent Manage 0.6.3-company.5 包含新核心异步初始化适配。桌面依赖图用归档覆盖固定整个核心版本。

桌面数据代际升为 2。首次启动在后端写入数据前原子保存旧选择并切到新内置基线，保留登录文件、会话、设置、工作区及旧版本目录。旧核心插件组合不能重新激活；旧桌面的代际检查会阻止降级读取新数据。启动失败仍使用新核心基线，不自动回退旧核心。DSH 自己维护会话/数据库的前向迁移；桌面代际标记不改写业务数据。

## 自动检查与一键更新

桌面启动时检查公司插件和客户端版本，周期检查间隔支持 1–168 小时，默认 24 小时。插件中心可请求批量准备并在成功后重启一次；失败或取消不自动应用。核心数据升级仍清除旧的待应用状态，保留更新偏好与已验证摘要历史。准备状态只在后台清理完成后显示为可重启。

批量更新在下载前校验当前宿主组合和更新后的目标组合；任一组合不兼容时拒绝准备，保持当前插件不变。重复调用启动入口不会重复发起启动检查。

## 桌面 0.0.12

原生菜单显式使用简体中文，保留退出、编辑和缩放等既有系统动作；不恢复工作台全屏按钮。

内置 DSH 0.1.6 公司核心，更新下载状态靠近设置入口显示，并提供进行中的动画；准备完成后的“下载并重启”操作改为红色强调。
业务版移除默认的本地工作区快捷打开按钮，仍保留“选择打开方式”菜单。
数据代际仍为 2，不修改用户登录、会话或工作区。
