# Windows 0.0.24 启动与更新状态回归

结论：确认两处 ASAR 布局兼容遗漏，均能用已发布源码复现。本地修复通过，尚未打包或发布修复版。原始附件未修改。

## 现场证据

- 16:39:44（UTC+8）旧插件组合仍正常启动；更新记录显示 GEA 0.0.127 → 0.0.130。
- 16:44:00 至 16:46:05，启动在 onboarding.mjs 加载依赖时失败：`Cannot find module 'yaml'`。尚未进入默认预设准备阶段。
- 16:46:32 起切换 baseline 后 Host 已启动，随后插件中心反复报告 `CONTROL_ACTION_FAILED`。
- selection.json 为 active/verified=baseline、booting=null、error=null；update-state.json 是可解析的 JSON，最后检查错误为 `MODULE_NOT_FOUND`，releases 为空。
- 16:47:42、16:47:52 才分别记录清理8、1个无引用版本；发生在启动错误之后。没有释放字节统计，不能推算释放多少GB。

## 两个根因

1. 新安装包把 yaml 等核心依赖移入 ASAR，已有完整插件图仍用独立 Node 启动。onboarding 原先从新安装目录解析 yaml，未使用当前选中的完整图；独立 Node 无法沿原目录找到 yaml，导致启动退出。
2. baseline 虽通过 Electron Node-mode 读取 ASAR 启动，更新服务枚举版本时仍从物理 payload/node_modules 解析全部包。核心 SDK 已在 ASAR 中，因此 status/check 都会抛出 MODULE_NOT_FOUND，控制接口返回500/CONTROL_ACTION_FAILED，页面持续重试。

实际发布的 Windows payload 已复制到源码目录之外核对，避免开发 node_modules 掩盖故障：旧版本更新代码明确找不到 `@deepseek-ai/dsh/package.json`；修复后读到正确的0.1.6-alpha.1-company.1核心和GEA0.0.130，并成功读取真实OSS频道中的4个组件。历史版本摘要保持不变。

## 本地修改与验证

- onboarding 从显式共享核心或当前选中的完整插件图解析 yaml。
- 更新服务根据共享层归属解析核心包，业务插件仍从当前图读取；不以基线版本掩盖真实损坏的完整图。
- 新增两项先失败、后通过的回归：隔离目录中的旧完整图启动依赖；真实本地控制接口的更新状态/检查请求。
- 桌面回归125/125通过；实际Windows ASAR包的版本读取、OSS检查和摘要历史保留通过。没有在Windows设备上执行修复后的整包启动。
- 未修改同事的 selection.json、update-state.json、deployment.patch.json 或日志；未清空账号、会话、工作区或版本历史。

## 当前处置

现有同事保持baseline可继续使用已能打开的工作台。暂缓继续推广0.0.24 Windows包。需要通过新客户端安装包覆盖安装一次修复；单独更新GEA插件不能修改这两处壳/启动脚本。当前更新页自身失败，修复包应提供直接下载入口。

此前验收遗漏了“ASAR新壳继续运行旧完整插件图”以及“ASAR基线通过完整更新控制接口读取状态”两条路径；启动健康通过不能代表更新页面通过。

## 附件身份与本地证据

- desktop.log SHA-256：`731e171b6fcc0dc3b2850745eea230c242fbb144171dacefd6b24033888c8e06`
- selection.json SHA-256：`fd5bbc4836f36f458da0687aaf160a79e2f204ecddfe7cb88b52a3d44b39f77b`
- update-state.json SHA-256：`69e64038d0d3d0461b5898698d4bcb417e1e5d634f951ab46c5f42ebf32c2e93`
- deployment.patch.json SHA-256：`76a94241a781bca05681147c412e8cc815fb854adb28b8bed66c372439b8d5b6`
- 发布基线：`desktop-v0.0.24` / `b2abcff8e2ea8379aa60b5274a3b7a7e11dee1a9`
- 修复工作分支：`codex/windows-layered-update-fix`
- 本地验证记录：`.runtime/windows-update-regression/`；用户原始附件未收入源码。
