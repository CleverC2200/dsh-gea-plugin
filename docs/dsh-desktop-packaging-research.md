# DSH Desktop 打包方案对照与改进方向

研究对象：`dataelement/dsh-desktop` 当前主分支。结论只吸收与本项目 Electron 壳、Windows 安装器和发行验收相关的做法，不复制它的业务代码。

## 已确认的优秀做法

### 1. 发行文件清单在打包层明确裁剪

参考项目在 `electron-builder` 的 `build.files` 中直接排除 source map、TypeScript 声明、README/CHANGELOG/LICENSE、测试目录、文档目录和 examples，并移除只在构建期使用的依赖。这样做的价值是减少安装器需要解压和复制的文件数，而不只是减少下载体积。

当前项目的 payload 是通过 `compact-payload.py` 独立准备的，因此采用同一思路放在 payload 阶段更合适：保留 `.js/.ts` 运行代码，裁掉明确的类型声明、包文档、测试/示例目录；客户端确实需要的 source map 仍由后续优化步骤重新生成。当前候选已从约 364MB 降到约 294MB，客户端资源校验通过。

来源：[参考项目 package.json 的 build.files](https://github.com/dataelement/dsh-desktop/blob/main/package.json)。

### 2. 限制 Electron 自带语言包

参考项目只保留 `en-US`、`zh-CN`、`zh_CN`、`zh-TW`、`zh_TW` 五个 Electron locale。当前项目原始 `win-unpacked/locales` 约 48MB、55 个文件；已在 `electron-builder.cjs` 加入同样的白名单。业务插件自己的语言资源不受影响。

### 3. 强制目标平台原生构建

参考项目在构建前检查宿主平台和架构，并明确拒绝从 macOS/Linux 交叉打 Windows 可发行包；Windows x64 包在 `windows-2022` 原生 runner 构建，随后运行打包后的 Windows smoke test。

这对当前项目很重要：macOS 上的 electron-builder 目录校验只能证明配置和文件布局，不能证明 Windows 安装器、Windows 原生 Node、`.node` 原生模块和 NSIS 行为。后续应把“Windows 原生构建 + 安装/启动 smoke”作为正式性能数据入口。

来源：[参考项目 target-native 打包说明](https://github.com/dataelement/dsh-desktop/blob/main/docs/development.md)、[Windows release job](https://github.com/dataelement/dsh-desktop/blob/main/.github/workflows/release.yml)。

### 4. 把签名从构建和性能诊断中分离

参考项目先在 Windows runner 产出未签名包和 `win-unpacked`，再在受控签名环境扫描并签名所有根目录 PE、Node runtime 和 Windows `.node` 原生模块，重新封装 NSIS，最后重新生成 blockmap 和 `latest.yml`。

这比把私钥放进普通 Windows 构建机更安全，也不会让签名耗时混入安装速度诊断。当前项目已经支持证书门禁；正式发行时可进一步借鉴“Windows 构建产物 -> 安全签名 -> 重封装 -> 重新生成更新元数据”的流水线。

来源：[签名扫描脚本](https://github.com/dataelement/dsh-desktop/blob/main/scripts/sign-windows-unpacked.mjs)、[签名工作流](https://github.com/dataelement/dsh-desktop/blob/main/.github/workflows/release.yml)。

### 5. 把原生依赖作为打包后验收项

参考项目不是只检查安装器文件存在，而是在隔离目录启动打包后的应用，确认 `node.exe` 从包内解析，并实际加载 `koffi` 这类 Windows 原生模块。当前项目也有 Windows smoke 脚本和 payload 校验，但应继续把“包内 Node 路径、原生模块解析、应用重启、用户数据保留”绑定到同一份验收报告。

来源：[参考项目 Windows packaged smoke](https://github.com/dataelement/dsh-desktop/blob/main/.github/workflows/release.yml)。

## 不应直接照搬的做法

| 参考项目做法 | 当前项目处理 |
| --- | --- |
| `asar: false` | 当前壳文件少且使用 `asar: true`；慢点在外置 payload 的 `CopyFiles`，改 asar 不能直接解决。 |
| `compression: maximum` | 可能减小包体，但会增加解压 CPU；当前证据显示主要耗时在复制阶段，先不为压缩率牺牲安装时间。 |
| 直接使用它的 `build.files` 排除规则 | 当前 payload 由独立脚本组装，继续在 payload 阶段裁剪，避免 electron-builder 过滤后客户端资源摘要失配。 |
| 直接复制它的 Windows 签名流程 | 它使用 SafeNet UKey 和 Jsign，属于其公司签名基础设施；当前先保留可选证书门禁，不引入外部硬件依赖。 |

## 当前项目的优先级

1. **已完成**：payload 裁剪、Electron locale 白名单、5 项配置/诊断回归。
2. **下一步**：在 Windows 10/11 原生环境重新打包，实测 `CopyFiles`、总安装时间和包体大小；旧基线 `CopyFiles` 约 475.6 秒。
3. **若仍慢**：按文件数量、Defender/第三方杀毒扫描和目标盘路径做对照；只有拿到阶段数据后才考虑目录交换或安装器流程改造。
4. **正式发行前**：补齐 Windows 原生构建门禁、包内 Node/原生模块 smoke、签名后重封装和 blockmap/更新元数据校验。

## 参考资料

- [DSH Desktop README](https://github.com/dataelement/dsh-desktop)
- [DSH Desktop package.json](https://github.com/dataelement/dsh-desktop/blob/main/package.json)
- [DSH Desktop development guide](https://github.com/dataelement/dsh-desktop/blob/main/docs/development.md)
- [DSH Desktop release workflow](https://github.com/dataelement/dsh-desktop/blob/main/.github/workflows/release.yml)
- [DSH Desktop Windows signing script](https://github.com/dataelement/dsh-desktop/blob/main/scripts/sign-windows-unpacked.mjs)
