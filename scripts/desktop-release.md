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

`release-plan.json` 表示本次构建的完整更新文件通过校验，`published-and-anonymously-verified` 表示公网交付完成。实际客户端检查更新、下载、系统验签、替换重启与用户数据保留仍须各自验证。源码 PR、构建成功和安装包能下载均不能代替客户端在线更新验收。
