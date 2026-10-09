# UI 全家桶兼容迁移验收（2026-09-15）

## 结果

本机活动插件图已经从旧 `@linxin666/dsh-web-ui-all@0.3.5` 迁移到上游更名后的 `@linxin666/dsh-web-all@0.3.22`，GEA 保持 0.0.14，DSH 核心保持 0.1.5-rc.2。
真实客户端“软件更新 → 技术维护 → 组件状态与版本”已显示新包“运行中”，任务看板已打开。

## 根因

1. 旧包没有列入桌面启动的 bundles，因而显示“未启用”。直接启用会因旧 settings SDK 导出 `installSettingsSection`、`settingsNamespace` 缺失导致启动失败。
2. 仅换聚合包不够：旧安装图的 overrides 把子包固定在 0.3.5，sidebar 固定在 0.15.2。迁移时移除这组旧锁，实际子包升级到 0.3.22，sidebar 到 0.19.0。
3. pnpm 会移除新版不再使用的传递 SDK `dsh-client-runtime`。原安装器把这种合法移除当成安装失败。修复后仍严格检查直接核心依赖存在、所有保留 SDK 版本不变。
4. 桌面启动会重写 profile 的 bundles。通过原生用户层 `cordis.patch.yml` 加载新包的补丁行，启用可以跨启动保留。

## 验证证据

本工作树 `.runtime/ui-bundle-compat/` 保存诊断回执（临时调试目录，不含登录凭据）。

- `result.json`：旧包真实失败，缺少 settings 导出。
- `upstream-result.json`：只升聚合包、保留旧锁时仍失败。
- `verified-result.json`：完整迁移、原生桌面启动路径通过；默认启用的 13 个组件无降级；主页面和任务看板无 pageerror。
- 测试 mock 原 `/plans` 缺少 `dealerCode`，会触发 GEA 工作台 `.trim()` 异常。插件兼容测试改用合法空列表；未把这个错误伪称为 UI 全家桶错误或修改业务源码。
- `live-prepared.json`、`activation-backup.json`：本机准备和切换记录。
- `desktop/installer-sdk-pruning.test.mjs`、PluginStore、copy-graph：7 项测试通过。

## 本机落地与回退

数据根：`~/Library/Application Support/dsh-gea-desktop`。
活动图：`plugins/versions/web-all-0.3.22-20260915`，selection 已 verified 且 error 为 null。
旧图：`channel-f42f4410-c0ec-492e-a62e-0df49dcc520f` 保留。
用户补丁原本不存在；本次新增 `data/home/profiles/full/cordis.patch.yml`。

如需回退：先正常退出客户端，将本次新增的用户补丁移到备份位置，再通过 PluginStore.activate 选择旧图后启动。不能只换回旧图而保留引用新包的补丁。

## 范围与限制

使用 npm 已发布的上游版本，没有发布同版本的修改包，也没有更换客户端程序。安装器源码修复留在 `codex/ui-bundle-compatibility` 工作树，尚未打入新的桌面安装包。
未验收远程访问、Git 写操作、定时任务等全部业务操作。上游“检查更新”将本地 tgz 安装识别为开发模式，后续应继续通过公司维护流程更新。
新版默认附带动漫皮肤和桌宠；功能启用不等于界面偏好确认，界面选择单独处理。
