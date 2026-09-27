<!-- collaboration-record
{"kind":"bug","id":"BUG-20260927-layered-runtime-resolution","date":"2026-09-27","title":"ASAR新壳启动旧插件失败且基线无法读取更新状态","module":"客户端启动与更新","category":"构建发布","cause":"原始遗漏","severity":"P1","status":"已修复待验证"}
-->
# ASAR依赖解析回归

- 现场：同事更新客户端后旧完整插件图启动缺少yaml；手动选择baseline后可启动，但更新控制接口返回500/CONTROL_ACTION_FAILED。
- 根因：onboarding从新安装目录找依赖，忽略实际选中的完整图；更新服务从物理node_modules读取已移动到ASAR的核心版本。
- 修复：启动依赖跟随显式核心或当前插件图；版本读取根据共享层归属解析，不用基线伪装损坏的旧图。
- 引入范围：desktop-v0.0.24 / b2abcff8e2ea8379aa60b5274a3b7a7e11dee1a9所含ASAR改造；此前验收只覆盖启动健康，遗漏跨布局启动和更新接口。
- 两项回归先失败后通过，125项桌面测试通过；独立目录中的真实Windows ASAR恢复版本读取与OSS四组件检查，更新历史不变。
- 完整诊断见 docs/windows-layered-update-regression-20260927.md。客户端0.0.25修复包准备中，未声称Windows设备已验收。
- 无业务数据、功能、接口或测试删除；保留历史摘要、回退、手动版本和已有安全校验。
