# 插件市场运行状态修复（2026-09-14）

问题：`@linxin666/dsh-web-ui-all` 0.3.5 已安装但未加入 profile bundles，市场按“dsh 插件且未加载”反复显示待重启。

修复：宿主返回 runtimeStates；列表和详情页统一使用此状态。未启用 bundle 显示“未启用”；本次启动后才加入 bundles 的插件显示“待重启”；启动配置已包含却没有加载的插件显示“未加载，请检查日志”。loader 不可用或配置不可读时显示“状态未知”，不建议盲目重启。禁用的 loader entry 不再计为运行中。

`plugin-runtime-status.patch` 基于本机已发行的 dsh-plugin 1.4.3-company.2 源码，不覆盖公司渠道相关改动。下一次制作插件发行包时，在插件根目录应用此补丁，将旁边的测试文件复制到该插件的 tests/runtime-status.test.ts，然后执行 npm run typecheck、node --test tests/*.test.ts 和 npm run build。该测试文件的相对导入以插件 tests 目录为准，不能在此目录直接运行。

同样的源代码修复已应用到相邻 dsh-plugin-hub 仓库。本机已更新活动插件版本目录和应用内置副本；尚未发布远端更新或重制安装器。

验证：74 项通过、2 项原有网络测试跳过；类型检查及构建通过。重启本机工作台后，installed API 返回 web-ui-all=disabled，其余已加载插件=running；实际列表和详情页都显示“未启用”，该行无重启按钮。

原文件备份及目标清单在 ../../.runtime/plugin-status-fix/backups/manifest.json。全家桶兼容性尚未修复，也未将它加入 bundles；此修复只纠正状态和操作提示。
