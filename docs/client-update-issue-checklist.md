# 客户端更新后插件加载失败排查清单

## 这次问题的结论

客户端更新或重启后，界面显示 `Failed to load plugins`，GEA 页面无法进入。

根因是桌面客户端长期保留了旧运行时的 `dsh-auth-*` HttpOnly Cookie。每次本地后端重启都会使用新的端口和认证 Cookie，旧 Cookie 没有清理，最终在批量请求插件脚本时一起发送，触发 `431 Request Header Fields Too Large`。插件包本身、频道下载和校验没有问题。

本次已经在桌面启动流程加入启动时清理运行时认证 Cookie 的修复：

- `desktop/main.cjs`：启动时调用 Cookie 清理逻辑；
- `desktop/runtime-cookies.cjs`：只清理 `127.0.0.1` 和 `localhost` 下名称以 `dsh-auth-` 开头的 Cookie；
- `desktop/runtime-cookies.test.cjs`：覆盖清理和保留其他 Cookie 的回归测试。

源码修复已合并到 `main`，合并提交为 `6f24a6826f3311be064ca55ee1fe1c0eb132b132`。

## 现象确认

- [ ] 客户端窗口显示 `Failed to load plugins`。
- [ ] 页面没有正常加载 GEA 或其他插件内容。
- [ ] 记录发生时间、客户端版本、更新前后版本和复现次数。
- [ ] 先确认不是单个业务页面报错，而是插件批量加载失败。

## 证据收集

收集日志时不要复制 Cookie 值、认证 Token、带查询参数的完整 URL 或业务数据。

- [ ] 查看自动更新日志：

  ```bash
  tail -200 ~/Library/Logs/GEA/main.log
  ```

- [ ] 查看桌面运行日志，确认后端是否成功启动：

  ```bash
  tail -240 "$HOME/Library/Application Support/dsh-gea-desktop/desktop.log"
  ```

- [ ] 打开 DevTools 的 Network，找到批量插件脚本请求 `/plugins/??...`，记录状态码和响应大小。
- [ ] 如果状态码是 `431`，查看 Request Headers 是否出现大量 `dsh-auth-*` Cookie；只记录 Cookie 名称和数量，不记录值。
- [ ] 用不带浏览器 Cookie 的请求复核同一插件 URL；如果返回 `200`，说明插件包和 URL 正常，问题集中在客户端 Cookie/header。
- [ ] 如果是 `404`、`500` 或脚本导入错误，再转到包内容、插件图谱和版本兼容性排查，不要按 Cookie 问题处理。

## 建议排查顺序

| 顺序 | 检查项 | 结论 |
| --- | --- | --- |
| 1 | 本地后端是否启动、健康检查是否正常 | 后端没启动时先查启动日志和端口 |
| 2 | 更新频道、包下载、SHA-256 是否一致 | 下载或校验失败时查发行库和频道 |
| 3 | 插件批量请求状态码 | `431` 优先查 Cookie/header |
| 4 | 插件脚本响应和导入错误 | `404/500/import failed` 查包内容和兼容性 |
| 5 | 客户端、DSH Core、插件版本组合 | 只在前面检查正常时判断版本兼容 |

## 用户现场恢复

### 新版客户端

- [ ] 完全退出客户端后重新启动。
- [ ] 启动时自动清理旧运行时认证 Cookie。
- [ ] 页面不再显示 `Failed to load plugins`。

### 旧版客户端的一次性恢复

仅在确认是 `431` 且无法立即安装修复版时使用：

- [ ] 完全退出客户端。
- [ ] 备份后移动以下文件，不要直接删除：
  `~/Library/Application Support/dsh-gea-desktop/Cookies`
  和 `Cookies-journal`。
- [ ] 重新启动客户端并检查插件页面。
- [ ] 不要移动 `data`、`home`、登录信息或工作区文件。
- [ ] 现场处理完成后，把备份文件路径和时间记录下来，避免把 Cookie 数据提交到工单或聊天中。

## 修复验证

- [ ] GEA 页面可以正常显示，窗口不再提示插件加载失败。
- [ ] DevTools 中插件批量请求返回 `200`，不再返回 `431`。
- [ ] 连续重启客户端后，旧 `dsh-auth-*` Cookie 不会持续累积。
- [ ] 运行桌面单元测试：

  ```bash
  pnpm run test:desktop:unit
  ```

- [ ] 验证包内包含 `desktop/runtime-cookies.cjs`，避免构建配置漏打包运行时依赖。

## 后续发布项

- [x] 桌面源码修复已合并：`6f24a6826f3311be064ca55ee1fe1c0eb132b132`。
- [ ] 使用固定的 Electron Builder 环境构建桌面安装包。
- [ ] 在测试频道安装验收：启动、插件加载、重启后再次加载。
- [ ] 将同一个已验收安装包提升到正式频道。
- [ ] 记录桌面版本、安装包 SHA-256、频道和验收时间。

当前未完成桌面安装包发布，原因是本机没有可复用的固定 Electron Builder 环境和已核验的构建产物；这不影响源码修复和本地 Cookie 清理恢复。
