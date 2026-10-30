# 官方布局 Windows 公司包

`Delivery fixture checks` 的 `workflow_dispatch` 接受 `windows_complete_input` JSON。双端完整包的 Core 由 `scripts/ci-core-policy.json` 的 required 项统一选择，采用当前 workflow GEA HEAD 和已发布三包。GEA `package:desktop:win` 是旧壳入口，不产生此完整客户端。

先用公开输入检查，不执行构建：

```sh
node scripts/windows-complete-local/input.mjs --input /absolute/final-desktop-input.json --source-sha <actual-workflow-head>
```

输入沿 `released-input.fixture.json` 的结构填写真实最终版本、GEA SHA、三包不可变 OSS URL 与 SHA、Core proof 和原更新来源。该夹具保留2026-10-18真实归档身份与当时 App 的 Core proof，现在用于旧输入拒绝回归，不是可复制的当前发行输入。`DESKTOP_CORE_POLICY_MISMATCH` 要求重新生成当前 Core 的输入与产物证明，不能只改 head。最终三包必须先通过普通交付和公开 `release:preflight`，保留原交付与源码覆盖证明。桌面版本仍由发行负责人核全部已用版本后分配。

Mac 输入检查增加 `--mac-baseline`，与实际构建使用同一底包校验。底包是不可变的完整 App，不能通过更新插件或改写 metadata 升级 Core。`DESKTOP_MAC_BASELINE_CORE_MISMATCH` 要求先从 required Core 重建完整底包，再更新 `scripts/mac-complete-local/baseline.mjs` 的来源和摘要。当前登记的历史底包会被拒绝；此修复未生成新底包或替换已安装客户端。

Windows job 实读两仓HEAD及clean、下载三TGZ并核SHA及manifest，再运行官方构建、seed准备、NSIS封包、runtime smoke和隔离首装。`result.json`保留新installer、native EXE、ASAR、原入口SHA、真实包metadata、seed及runner。公司适配器保持桌面 mandatory policy 未配置；签名模式复用 Core 的 electron-updater 和安装事务，未签名诊断模式保持 publish:null。构建回执的`actualNativeUpdateAcceptance`恒为false。

可选 `native_acceptance_bundle_url` / `native_acceptance_bundle_sha256` 用于批准的R9真实更新验收。URL限定OSS `client-release/verification/<sha256>/<name>.tgz`，先核整个bundle SHA与tar路径/普通文件类型，解包到RUNNER_TEMP。必须含`package/windows-run.mjs`，调用参数为`--build-receipt <absolute result.json> --input <absolute original input> --output <absolute new directory>`。验收脚本可从build的`geaRoot/package.json`解析项目固定Playwright，真实Native正常主进程由bundle负责启动。

bundle失败使job失败。其`receipt.json`须为`status:passed`、`actualNativeUpdateAcceptance:true`，并绑定`buildReceiptSha256`原字节SHA和`inputSha256`。无bundle时仅构建，Native更新仍未验。artifact只留R9回执、bundle绑定及`public/`脱敏证据；raw请求和配置由验收目录的隐私合同单独保全。

## Windows 首次安装证书与在线更新

完整 Windows 构建默认 `windows_signed=true`。首次安装内置 `desktop/build/codesign.cer` 和公钥导入脚本。安装器保持 Core 的当前用户安装模式，在解压新程序前检查 `CurrentUser\Root`，缺少证书时向用户说明信任变更，经确认后导入。已信任时不再提示；首次静默安装缺少信任时直接失败。卸载不移除证书，避免破坏同一签名者的其他安装。

签名构建要求构建机提供 `GEA_WINDOWS_PFX_FILE` 和 `GEA_WINDOWS_PFX_PASSWORD_FILE` 两个路径。PFX 必须与仓库内置的公钥完全一致。签名器在有管理员权限的构建机上将公钥导入 LocalMachine\Root，用于无人值守验签，并检查 Windows 验签状态、签名者和时间戳，失败即中止。私钥和密码不进入应用、更新清单或构建 artifact。`windows_signed=false` 只用于原未签名诊断构建，不启用在线更新。

GitHub 构建从仓库 secrets `GEA_WINDOWS_SIGNING_PFX_BASE64`、`GEA_WINDOWS_SIGNING_PASSWORD` 读取私钥材料，写入 runner 临时目录，结束后删除。仓库不包含这些 secret；配置这些值和正式发布由发行负责人办理。手工 Windows 构建可直接设置本地路径，无需上传私钥。

公司包装层复用 required Core 的官方更新入口、版本比较、下载、发布者校验、差分下载和安装重启，更新地址固定为 `https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/electron/win-x64/`。构建产物为签名 EXE、对应 `.blockmap` 和 `nightly.yml`；后续发布先上传 EXE 与 blockmap，再更新 `nightly.yml`，并保留旧版本供差分下载。现有桌面 JSON 频道仍服务旧客户端，本次不改它。新更新地址尚未发布内容，构建始终使用 `--publish never`。

已有客户端需要先安装一次包含新证书的引导版本，之后才能使用该证书验签更新。首次安装仍可能出现 Windows 安全提示。换证前必须提前部署新证书并核发布者兼容性，不能直接覆盖现有私钥。

`windows_certificate_test=true` 单独执行 Windows 机器证书库导入、重复导入、PFX 签名与时间戳夹具，使用临时测试证书，不使用正式私钥。它不构建完整桌面、不访问业务，也不证明真实旧版到新版升级。当前用户根证书导入可能出现 Windows 系统确认，保留给员工首次安装交互。完整 NSIS 安装、真实公司证书签包及真实客户端更新仍需各自验收。
