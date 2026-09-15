# GEA Electron 桌面

桌面壳固定 Electron 44.0.0、官方 DSH 0.1.5-rc.2、Node.js 24.14.1 和安装工具 pnpm 11.27.0。只交付 macOS Apple Silicon DMG 与 Windows x64 NSIS。安装包不携带维护者凭据。

## 首次启动

公司正式/测试地址与模型 ID 由 desktop/company.config.json 随发行版本提供，首次启动自动生成配置并直接进入扫码登录。不向业务用户展示连接表单，也没有“连接设置”菜单。已有配置保持原样，不覆盖用户会话。发行配置只含部署参数，不含凭据。

已有登录信息在后端启动前通过系统安全存储解密；系统授权提示的等待时间不计入后端本机通信的 5 秒超时。读取失败时显示启动错误并保留加密文件。指定 `GEA_ELECTRON_EXECUTABLE` 和 `GEA_DESKTOP_PAYLOAD` 运行 `node --test desktop/slow-login.test.mjs`，验证系统凭据读取耗时 8 秒时仍能恢复登录并打开工作台。

## 独立插件版本

首次从 payload 基线启动。菜单“插件版本 → 准备本地插件包”接收已构建 tgz，复制基线的代码与锁到用户目录暂存区，通过官方 `dsh plugin` 安装到该区。pnpm 由 payload/tools 提供，不调用同事机器上的开发工具。官方依赖逐项固定，安装后核对版本与公司插件的共享 Cordis 解析。

准备完成不会改变当前进程。组合存于 userData/plugins/versions，version.json 记录实际版本、依赖和锁校验值；“切换已准备版本并重启”串行停止当前后端、原子写选择、启动新组合。Electron 与内置 payload 不被修改。版本目录包含独立解析的完整图，避免官方 DSH 安装优先解析规则导致仍加载内置旧插件。

配置在 userData/gea.config.json，会话、设置与工作区在 userData/data。切换只更新 profile 的受管插件链接与清单，保留数据。DSH_GEA_DESKTOP_DATA 可指定隔离验收目录。普通 node_modules 目录不会被自动覆盖。准备区只复制包、代码、锁，不复制连接配置、账号或会话。

#37 只承诺手动选择已准备版本，不将自动回退列为已验收能力。不得把登录失败或外部 GEA 网络不可用作为后端启动失败。

## 构建和验证

公司发行必须加载 `dsh-agent-manage`，不能用第三方 `dsh-agent-plugins-market` 替代：后者能加载套件 Skills，但不包含登录后发现 GEA MCP 工具的集成。`installCompanyManage` 在新暂存图中移除旧依赖并安装公司包，保留原运行图以供回退。`compact-payload.py` 在复制前执行公司插件门禁，缺少公司入口或 MCP 模块时拒绝打包。

运行 `GEA_MANAGE_GRAPH=<payload或外置版本目录> node --test desktop/gea-mcp-bundle.test.mjs`，用实际分发插件和本地模拟网关验证登录后发现工具、退出后移除连接；此测试不访问生产业务数据。实际部署仍须验证当前登录用户的 Consumer 授权。

使用 electron-builder 26.15.3，`GEA_DESKTOP_PAYLOAD_ROOT` 指向新构建根，包含 mac/payload、win/payload。各 payload 必须包含相应平台 Node、生产依赖、标准发行包、pnpm 11.27.0 工具与 runtime-start.mjs 的 start.mjs 副本、onboarding.mjs。不能把 Mac 原生模块复用到 Windows。

`node --test desktop/config.test.cjs desktop/onboarding.test.mjs desktop/plugin-store.test.mjs` 验证配置、提示、版本目录与数据保护。指定 `GEA_DESKTOP_TEST_GRAPH` 运行 desktop/runtime-graph.test.mjs 验证外置启动；指定 `GEA_DESKTOP_BASELINE`、`GEA_DESKTOP_NEXT` 运行 desktop/version-switch.test.mjs 验证实际页面版本切换。

Windows 路径使用 file URL 动态导入、junction 与带引号的固定工具路径；在 Mac 的交叉检查不等于真实 Windows 验收。最终安装包交付票还需目标平台首次启动、升级、失败恢复证据及签名状态。

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

准备脚本通过 Agent Manage 的 `archiveInstall` 从公司源下载资源到 `payload/resources/company-agent-suites`，记录归档摘要；这一步只在构建机联网，客户端启动不下载。Mac 和 Windows 使用相同的纯文本资源快照，各自安装平台依赖。Mac 执行 MCP 和客户端启动验证，两份最终 payload 均检查平台原生模块，再调用 electron-builder。Windows 未通过真实安装和启动测量前，只能报告交叉构建与静态检查结果。

Windows 保留 NSIS 默认 7z 安装方式，通过减少依赖文件和包体缩短安装过程。资源同步使用 Agent Manage 0.6.3-company.4，修复 Windows 解压路径分隔符检查和大归档并发写入问题。

插件更新先在专属暂存目录执行 pnpm install，协调构建机与客户端的存储路径及平台目录设置，再安装选中的插件。需要重建的依赖仅位于暂存目录，正在运行的版本和业务数据保持可用。

`GEA_DESKTOP_PAYLOAD=<payload> GEA_PLUGIN_ARTIFACT=<GEA-0.0.7.tgz> node --test desktop/installer-portability.test.mjs` 在复制的依赖图中模拟另一台机器的存储路径和目录长度，执行真实 pnpm 安装并检查当前选择与业务配置不变。

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
- `GEA_GITLAB_BASELINE=<旧payload> GEA_GITLAB_ELECTRON=<打包后的应用可执行文件> node desktop/gitlab-electron-smoke.mjs`：真实桌面 UI 下载、重启与版本切换；仅 GEA 登录使用本地模拟服务，发行下载与安装均为真实操作。

以上脚本使用自己的临时数据目录并关闭自己启动的进程，不操作用户的日常应用数据。

Windows 包验收先记录 GitLab 网络可达性。能访问公司网络时执行在线检查、下载和重启；公共 CI 无法访问内网时，通过应用原有的本地插件菜单安装与 GitLab 摘要一致的归档并切换版本，报告单独标记 `local-verified-archive`，不能据此声称 Windows 已完成内网下载验证。Mac 验收直接读取真实 GitLab 频道。
