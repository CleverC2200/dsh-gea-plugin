# 官方布局 Windows 公司包

`Delivery fixture checks` 的 `workflow_dispatch` 接受 `windows_complete_input` JSON。它恢复历史成功的 Windows 完整构建链，固定 Core8cf，采用当前 workflow GEA HEAD 和已发布三包。GEA `package:desktop:win` 是旧壳入口，不产生此完整客户端。

先用公开输入检查，不执行构建：

```sh
node scripts/windows-complete-local/input.mjs --input /absolute/final-desktop-input.json --source-sha <actual-workflow-head>
```

输入沿 `released-input.fixture.json` 的结构填写真实最终版本、GEA SHA、三包不可变 OSS URL 与 SHA、Core proof 和原更新来源。该夹具的归档身份来自2026-10-18已发行W10/M19/G164，Core proof来自当时真实App；日期后缀只用于输入回归。它不是本次已批准发行输入。最终三包必须先通过普通交付和公开 `release:preflight`，保留原交付与源码覆盖证明。桌面版本仍由发行负责人核全部已用版本后分配。

Windows job 实读两仓HEAD及clean、下载三TGZ并核SHA及manifest，再运行官方构建、seed准备、NSIS封包、runtime smoke和隔离首装。`result.json`保留新installer、native EXE、ASAR、原入口SHA、真实包metadata、seed及runner。公司适配器保持现用App未配置桌面mandatory policy、unsigned/publish:null的语义，原Core和插件签名/安装事务保持。构建回执的`actualNativeUpdateAcceptance`恒为false。

可选 `native_acceptance_bundle_url` / `native_acceptance_bundle_sha256` 用于批准的R9真实更新验收。URL限定OSS `client-release/verification/<sha256>/<name>.tgz`，先核整个bundle SHA与tar路径/普通文件类型，解包到RUNNER_TEMP。必须含`package/windows-run.mjs`，调用参数为`--build-receipt <absolute result.json> --input <absolute original input> --output <absolute new directory>`。验收脚本可从build的`geaRoot/package.json`解析项目固定Playwright，真实Native正常主进程由bundle负责启动。

bundle失败使job失败。其`receipt.json`须为`status:passed`、`actualNativeUpdateAcceptance:true`，并绑定`buildReceiptSha256`原字节SHA和`inputSha256`。无bundle时仅构建，Native更新仍未验。artifact只留R9回执、bundle绑定及`public/`脱敏证据；raw请求和配置由验收目录的隐私合同单独保全。
