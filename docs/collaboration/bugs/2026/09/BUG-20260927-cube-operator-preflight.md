<!-- collaboration-record
{"kind":"bug","id":"BUG-20260927-cube-operator-preflight","date":"2026-09-27","title":"Cube操作符未枚举导致SQL等号漏过预检","module":"受控查询","category":"功能逻辑","cause":"原始遗漏","severity":"P1","status":"已发布待验收"}
-->
# Cube操作符预检缺口

原工具Schema只声明string，预检只检查非空，导致`operator="="`发往下游。只读Cube日志中同一查询出现`Invalid query format: filters[1] does not match any of the allowed types`；不是由这条日志证明的权限拒绝。

修复650357d：Schema和预检共用Cube操作符清单，等值使用equals，SQL的=、IN、between等在发送前拒绝。tests/cube-preflight.test.mjs同时覆盖非法别名与合法操作符；未扩大模型/字段授权。

0.0.128待发布。跨系统请求ID未在原日志中直接串联，记录以相同查询及时间窗匹配为边界。


2026-09-27发布补记：GEA 0.0.128已通过MR !186合入并发布到OSS/GitLab的dsh-0.1.6测试及正式频道。固定源码688991d3e0b20efa035acbc14ee3c9337bfdb1a5，包SHA-256 fabdad3485ce5cd74d1c7a68f6bfa8ec652092440b7e710cacee7bfb1c8be7fc。实际包空目录安装及原生Harness启动通过，真实账号问答仍待验收。
