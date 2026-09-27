<!-- collaboration-record
{"kind":"bug","id":"BUG-20260927-dsml-spaced-calls","date":"2026-09-27","title":"带空格的DSML calls文本漏检并被记为完成","module":"模型流与业务Agent","category":"功能逻辑","cause":"原始遗漏","severity":"P1","status":"已发布待验收"}
-->
# DSML协议文本漏检

分仓问答耗尽调用额度后返回`<｜｜DSML｜｜ calls>`。旧检测只识别紧接标记的tool_calls/invoke，因此原始工具协议被记录为正常完成，工具并未实际执行。

修复650357d：检测迁入真实SSE解析器，覆盖空格、calls/tool_calls/invoke及分片；Host继续返回PROVIDER_PROTOCOL分类。tests/gea-stream.test.mjs及tests/gea-model.test.mjs覆盖失败结束状态和不执行协议文本；完整639项回归636通过、3跳过。

版本0.0.128待发布。它修复确定性的漏检，不等于模型以后必然交付业务答案；真实账号复杂问答仍待复测。原协议保护保留并扩展，无取消旧修复。


2026-09-27发布补记：GEA 0.0.128已通过MR !186合入并发布到OSS/GitLab的dsh-0.1.6测试及正式频道。固定源码688991d3e0b20efa035acbc14ee3c9337bfdb1a5，包SHA-256 fabdad3485ce5cd74d1c7a68f6bfa8ec652092440b7e710cacee7bfb1c8be7fc。实际包空目录安装及原生Harness启动通过，真实账号问答仍待验收。
