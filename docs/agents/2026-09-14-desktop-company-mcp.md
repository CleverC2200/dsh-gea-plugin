# 桌面公司 MCP 插件遗漏修复

已安装的 GEA Desktop 0.0.3 基线加载 `dsh-agent-plugins-market@0.6.2`，它来自第三方原仓库，未包含公司 `mountGeaMcp` 接入。GEA 本身已提供 `geaMcp` 服务。套件 Skills 可用不能证明 MCP 集成存在。

公司发行使用 `dsh-agent-manage` 替换原插件。替换在新的外置插件图中完成，移除旧依赖及覆盖配置，保留基线可回退；用户数据不复制到插件图。`desktop/company-manage.mjs` 提供准备和校验函数，`compact-payload.py` 在精简发行产物前调用校验，拒绝漏装公司入口或 MCP 模块的基线。

回归命令为 `GEA_MANAGE_GRAPH=<实际插件图> node --test desktop/gea-mcp-bundle.test.mjs`。原安装基线登录后返回空 MCP 列表，测试失败；修复图通过同一测试，覆盖登录发现工具和退出移除连接。公司版 Agent Manage 的 MCP 生命周期与预设范围测试共 8 项通过，构建与类型检查通过。

本机通过桌面菜单启用 `gea-mcp-fix-20260914` 外置图，启动回执 verified 为该版本，previous 保留 baseline。真实登录后的 MCP 页显示 `gea-gateway` 和 5 个工具，原有 2 个公司资源套件保留。本次没有执行生产业务工具调用或发布远端安装包；其他机器仍需分发修复后的插件图或重新构建安装包。
