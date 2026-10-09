# Windows 安装慢：同盘移动诊断候选

状态（收到实机报告后更新）：候选在一台 Win11 25H2 上安装成功，实际安装 110.438 秒，同盘移动 0.078 秒，未执行 CopyFiles。四项原生自检通过。完整覆盖升级、安装后的启动/数据保留及其他同事机器仍未确认；未合并、未发布。详见 [本次实机结果](windows-install-result-20260927.md)。

## 已确认的输入

- 历史对话：`01a0ae12-7fb1-7230-b7e5-27c9cc8897e4`，已逐页读取。
- 最新用户反馈：正式最新版仍通常安装约 10 分钟，有同事反馈半小时；之前的 3–5 分钟不是可靠验收结论。
- 历史 Win11 报告：复制 475.640 秒，解压 152.015 秒，旧卸载器 154.750 秒；实际安装 section 800.015 秒。此历史机器日志不是当前 0.0.22 的实测。
- 重新解析保留的历史云端轨迹：复制 56.344 秒、解压 47.094 秒、旧卸载器 51.812 秒。Server 2022 的结果不代表 Win10/11。
- 2026-09-27 回读 OSS 正式桌面频道，最新为 0.0.22，源码 `842cffd3ecff3938d333a3eac1eca283504d0d50`。
- 本地正式 EXE 的 SHA-256 与频道一致：`b97f23d044a6a07edeba1ccd8db82a5df366a6860b93da09791cfaec675658d9`，264,420,852 bytes。
- 该 EXE 的应用内容：24,202 个文件，828,142,268 bytes（约 790 MiB）；最长相对文件路径 184 字符。已有裁剪基本生效，剩余 source map 包括客户端优化所需文件，不继续盲删。

## 候选改动

只复用 0.0.22 的应用内容并调整诊断安装器；不变更插件版本、应用数据位置、正式打包配置或发行频道。

1. 使用安装目录中的本次唯一暂存目录，在目标盘上解压，并继承该目录的权限。
2. 完成解压后，尝试 `Rename` 顶层条目；不覆盖已有目标，不使用延迟到重启的替换。
3. 非递归删除暂存目录成功才表示全部条目移走，可跳过 CopyFiles。目录仍非空或移动失败时，保留上游 CopyFiles、重试和最后直接解压的兜底路径。
4. 无法在目标目录创建暂存区，或附加暂存层使包内最长路径达到 MAX_PATH 时，回退原临时目录/复制路径。
5. 清理只指向本次创建的暂存目录；未增加“安装失败恢复完整旧版本”的承诺，上游安装本身也不是整包事务。

通过 `prepare-installer-diagnostics.mjs ... --fast-move` 显式启用，普通诊断与正式安装默认行为保持不变。模板仍固定 electron-builder 26.15.3，替换锚点不匹配即失败，不修改共享工具缓存。

## 验证

| 验证 | 结果 |
| --- | --- |
| 新测试对旧代码 | 1 项失败，证明旧路径缺少移动分支；这是结构检查，不是性能复现 |
| 12 项定向测试 | 通过，包含原重试/兜底保留、模板漂移拒绝、普通配置和壳清单 |
| NSIS 自检 EXE 编译 | 通过，开启 warnings-as-errors |
| 完整候选 NSIS EXE 构建 | 通过，固定 builder 26.15.3 / NSIS 3.0.4.1，未签名 |
| 应用内容对比 | 24,202 个文件逐一 SHA-256 与正式 0.0.22 相同 |
| 最终重构建内容 | 内嵌归档 SHA 与上述已验证候选相同，应用内容未变化 |
| 本机 Wine 运行 | 不可用；组件缺失导致 c0000135，未执行到探针，不记为通过 |
| Win10/11 真机 | 待完成 |

定向测试：

```sh
GEA_BUILDER_LIB=<app-builder-lib目录> node --test \
  desktop/installer-transfer.test.mjs desktop/installer-timing.test.cjs \
  desktop/packaging-config.test.cjs scripts/package-desktop.test.mjs
```

探针编译需指定 `PROBE_OUTPUT`、`TIMING_INCLUDE`、`TRANSFER_INCLUDE`、`GEA_MAX_RELATIVE_PATH=24`（探针自身 fixture 的最长路径）。实际安装器的路径长度由构建入口扫描 prepackaged 内容自动计算。

## 交付与一次验收

- ZIP：`GEA-Windows-fast-transfer-20260927.zip`，264,482,774 bytes。
- ZIP SHA-256：`84773f2b6fe37fcfadc0f9c47efcdec1c7d716718ed06b7142179fe1af2bf1f0`。
- 候选 EXE SHA-256：`7d5cc1a96d75560bf0786b3b626b630ed0ed00f6173f729e3ea2c70b84c2aceb`。
- 包中 BUILD-INFO.json 保存输入文件摘要；代码仍为本工作树的未提交候选，基线 `2a3ce39ffd6e0c0184e394953d83e01dcd01b336`，分支 `codex/windows-install-speed`。
- 本次源包审计、两次构建与逐文件验证证据位于本工作树 `.runtime/installer-tools/`。

完整解压后运行 `run-install-diagnostics.cmd`，不要直接启动候选 EXE。采集器先校验并执行隔离探针，测试 128 个小文件、已有目录/占用文件、无法创建暂存区与长路径回退；退出码和完成日志都通过才启动安装。失败只保留报告，不开始覆盖。

在慢机器上保持原安全软件配置，完成页取消启动应用并点击完成，发回 `GEA-report-*.zip`。重点比较 `sevenzip-extract`、`move-new-entries`、`transfer-result needsCopy`、`copy-files`、`install-stage-cleanup`、旧卸载器和进程退出；完成页停留不算实际安装。安装后另核对启动、登录和数据保留。跨安装盘、全新/覆盖、每用户/所有用户安装仍需要相应 Windows 验收，不以本机编译替代。

当前没有该慢机器的可无人值守复现环境，因此交付停在受控诊断候选；待真实结果后决定是否合并与正式发布，不批量推广未验收包。
