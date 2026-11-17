<!-- collaboration-record
{
  "kind": "change",
  "id": "CHANGE-20261112-mps-release",
  "date": "2026-11-12",
  "title": "MPS修复与提速插件发行 0.0.270",
  "module": "主生产计划(MPS)",
  "status": "已发布待验收"
}
-->
# MPS 修复与提速发行

只升版本并将 Workbench 0.1.93、Manage 0.6.3-company.65 加入既有伴随包兼容声明。业务身份、Consumer、受控 SQL 和后端接口逻辑不变。

- 对比基线：`3edc0936ee586658ed82b500967a215417cab7d5`，目标版本 `0.0.270`。
- 已整合当前 GitHub 主线，保留主线新增的菜单、更新与业务资源修复；本轮未发现候选删除文件或有意取消旧修复。
- 验证：正式三包固定来源构建、发布预检、生产来源下载与官方隔离安装接收通过，详见发行回填。
- 发布技能：本机 dsh-plugin-release 1.3.1，local_draft，未声明为团队同步版本。
- 发布状态：已发布至测试、正式插件频道；GitHub Release 已发布并读回。原源码标签与归档保持固定。
- 业务边界：本轮不补造源数据，不将未知数量改成0；源码、构建、安装接收与完整排产验收分别记录。

## 2026-11-12 发行回填

- 修复版本与固定来源：`0.0.270`，`f853eb5090d00998afbf7e69121b84d74e72a74e`。
- [GitHub Release](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.270)，包含 TGZ、release JSON 的固定下载地址、大小与摘要。
- 合并后 [主线 CI](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43143060447) 通过；本轮三包正式构建、发布预检、官方隔离安装与 Host/client 入口图观察通过。
- 测试频道 revision 108→109，正式频道 revision 100→101，均通过生产 reader 的 check 与三包匿名 download 校验。
- 归档 SHA-256：`871f28d5e024ad09913fc0e03cadc2c812ed57f03699af9850d5d11c8dd8cd6b`。
- 本轮未构建桌面安装包，未升级用户正式设备。MPS 真实取数与提速验收复用本轮授权开发 profile 证据；源数据待补仍输出异常，完整排产未验收。
