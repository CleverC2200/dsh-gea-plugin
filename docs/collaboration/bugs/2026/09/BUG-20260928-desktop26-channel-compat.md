<!-- collaboration-record
{"kind":"bug","id":"BUG-20260928-desktop26-channel-compat","date":"2026-09-28","title":"插件频道兼容名单遗漏桌面0.0.26","module":"客户端更新","category":"构建发布","cause":"原始遗漏","severity":"P2","status":"已发布待验收"}
-->
# 桌面0.0.26频道兼容

DSH0.1.6四个插件条目只列到桌面0.0.25，实际校验器在0.0.26拒绝整份清单。本轮补齐四个条目的0.0.26兼容范围，不合并MR203或发布桌面安装器。

用dsh-plugin 1.4.3-company.35校验器复现RELEASE_INCOMPATIBLE_DESKTOP，补齐后通过；已核对0.0.26源差异未改变DSH或插件运行时依赖。截图更新失败是否还有其它原因、Windows实际更新仍待验收。候选与GEA 0.0.135频道一起交付。

2026-09-28：GEA 0.0.135经MR !206、!207合并发布；四份频道和8个不同包地址匿名校验通过。发行回执：docs/releases/gea-0.0.135-verification.json。Windows实机更新与真实后端审批仍待验收。
