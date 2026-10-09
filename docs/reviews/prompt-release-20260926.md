# GEA 0.0.127 提交与历史修复审查

固定主线：13a35ea39570172b8eef80cde8f5895c41719322。功能候选：de4b1288e2c0c4bba730d97c06224e30e8eed6af；发布准备只增加版本、4个显式包文件与交接/团队记录。最终候选SHA写入MR和发行证据。

| 历史范围 | 本次行为 | 验证与判断 |
|---|---|---|
| 358d198 Session失效停止 | 保留session-expired整轮停止，证据回读不能重建过期网关 | authorized-cube-query、module-mcp、prompt-qa-regression覆盖，修复保留 |
| 45f4064授权、聚合和证据链 | 仍按当前owner/consumer/resource重验；原文先保留再投影，跨会话拒绝 | prompt-runtime、prompt-v2、authorized-cube-loop；修复保留 |
| 8e4ba44 / ff2615f新轮与作用域 | 会话独立状态，新轮清空；迟到目录按state/代次/epoch隔离 | turn-anchor、agent-read-convergence、prompt-runtime；修复保留 |
| 0e5eade网络故障提示 | 转换后用LlmError保留机器码，用户取消仍Abort | net-error、gea-model、gea-stream；旧接线断言适配转换形式，有真实Harness验证 |
| 17c87b6页面意图 / 工作台动作 | 独立取数不空读页面；已开放动作仍需明确意图、confirm及后台权限 | page-intent、preset-page-context、workbench-presence；未放宽后台权限 |
| Agent角色/规则与工具暴露 | 六业务Agent按任务装载；coding模式保留；短规则替换重复段落 | 此前用户批准整套优化及非权限修复；覆盖coding保留、失败加载不残留 |
| 打包清单 | 新增4个白名单文件，未移除旧入口、依赖或文件 | npm pack dry-run确认37文件；合并后做实际安装检查 |

相对主线没有D类文件；未删除API、依赖、既有Bug记录或测试用例。测试fixture的consumer调整仍验证后台拒绝，新增测试独立覆盖客户端跨域拒绝。摘要锚点压缩不删除历史用户原文；数据缺口和真实操作回执要求保留。

未发现需要额外确认的历史修复回退或实际功能删除。错误借用sales模型身份的行为不再保留，是已批准的身份修复；APS模型权限未扩大，限制已在实测报告和交接文档明确。

用户本次要求“客户端这边的改动提交下mr发一版”，覆盖当前GEA插件源码合入、固定包及既有插件测试/正式频道。管理端配置、Cube部署、资源套件发布、桌面安装器和权限更改不在执行范围。
