<!-- collaboration-record
{"kind":"bug","id":"BUG-20260928-skill-selection","date":"2026-09-28","title":"可发现业务Skill仍需先选择导致NOT_LOADED","module":"业务Agent与Skill","category":"功能逻辑","cause":"原始遗漏","severity":"P2","status":"已发布待验收"}
-->
# 可发现Skill的两阶段加载问题

旧版capabilities空参只列目录，另一个业务Skill即使可见，直接gea_skill读取仍报GEA_SKILL_NOT_LOADED。全链库存转读基地库存规则出现同类错误；这与业务数据资源授权是两件事。

MR !200使当前会话可见且允许模型调用的业务规则一步选择并加载；目录标明enabled/bodyLoaded，取消、路径、引用和资源校验保留。保留MR !190的分页字符串恢复，未取消历史修复。

原生Harness覆盖未绑定页面的全链Agent读取基地Skill，以及不可用Skill拒绝、正文加载状态和权限边界。候选0.0.134。测试使用模拟模型，不声称已经查到风险产品或解决Cube授权缺口。

2026-09-28：GEA 0.0.134经MR !202合入并发布，含MR !200；四份频道清单及8个不同包地址匿名读回通过。同事账号实际业务验收仍待进行。发行证据见 docs/releases/gea-0.0.134-verification.json。
