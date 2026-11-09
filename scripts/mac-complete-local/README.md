# 公司 Mac 签名与 DMG 交付

默认保留 DMG 手动安装和升级，安装包继续放在 `https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/`。默认不生成 ZIP、自动更新清单或 `app-update.yml`。显式传入 `--online-update` 时增加 ZIP、blockmap 和 `nightly-mac.yml`，App 在签名前写入公司 OSS 更新地址 `https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/electron/mac-arm64/`。不接入上游 Core 的更新或强制更新服务。构建不上传文件，不修改公司频道。

正式签名使用本目录 `signing.mjs`，或者为既有 `build.mjs` 显式设置 `GEA_MAC_SIGNED=1`。它转入完整源码构建，不使用临时签名底包重封装。Core 原有流程先签内嵌原生运行时，再生成完整性清单；electron-builder 签署 App 并完成 App 公证，DMG 完成后继续公证、装订票据和 Gatekeeper 校验。任一步失败不会写成功回执，凭据缺失不会回退临时签名。

凭据由目标 Core 的 `apps/desktop/.env.macos` 读取。也可设置 `GEA_MAC_SIGNING_CONFIG_DIR`，从独立私有目录中的 `.env.macos` 读取，供后续 Core checkout 复用。沿用 Core 模板中的应用标识、签名身份、Team ID、`CSC_LINK`、`CSC_KEY_PASSWORD` 和一组完整公证凭据；应用标识为 `com.cleverc2200.gea.desktop`。证书、密码和 API 私钥保存在源码树外，配置文件仅限本人读写。

先运行配置和真实签名探针，不构建客户端、不上传公证材料：

```sh
node scripts/mac-complete-local/signing.mjs /absolute/company-core --check
```

完整出包沿用 `full-source.mjs` 的固定输入、干净源码、主线来源及版本标签约束。`input.json` 使用 `windows-complete-local/input.mjs` 的三包和 required Core 合同；不更改原票或共享主环境的输入。准备目标 Core 的既有依赖后运行：

```sh
node scripts/mac-complete-local/signing.mjs /absolute/company-core /absolute/gea /absolute/input.json --plan
node scripts/mac-complete-local/signing.mjs /absolute/company-core /absolute/gea /absolute/input.json
```

`--plan` 检查输入和版本占用，仍会执行签名配置及探针，不上传安装包。实际出包会将 App 和 DMG 提交 Apple 公证。输出在 `$RUNNER_TEMP/gea-mac-source`，安装包名称以 `-mac-arm64-signed.dmg` 结尾；成功回执包含签名、公证、三包身份和手动升级方式。上传和对外分发继续作为单独阶段执行。

未选择正式签名模式的候选构建仍保留临时签名标识，其结果不能作为 Apple 公证或正式签名验收。

本地候选打包显式增加 `--candidate`，核版本尚未发布后允许未合入的工具源码，不创建远端标签、不上传包、不修改频道。候选必须使用新的桌面版本，正式发布仍要求主线来源和绑定三包组合的版本标签。在线更新候选示例：

```sh
node scripts/mac-complete-local/signing.mjs /absolute/company-core /absolute/gea /absolute/input.json --candidate --online-update
```

旧版 App 缺少 `app-update.yml` 时需要先手动安装签名 DMG，后续才可通过 ZIP 下载、验签、替换与重启。构建通过与实际更新分别验收。
