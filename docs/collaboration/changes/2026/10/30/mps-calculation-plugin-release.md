<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261030-dsh-gea-plugin-mps-calculation","date":"2026-10-30","title":"清理失效的页面Cube连接","module":"受控数据读取","status":"已验证待发布"}
-->

# 清理失效的页面Cube连接

页面Cube调用确认网关会话失效时，仅清除当前旧缓存连接，保留本次失败；下次公开读取重新建立受控连接和核验授权，不自动重试。

保留身份、Consumer、取消和失败语义，不扩大授权、不重发已失败的请求。整合main的0.0.205分仓DMS环境修复，不回退同事改动。

configured-html-query 20项回归通过；开发Mac重启后真实读取与MPS源值导出通过。包级安装、频道和远端CI按本轮发行结果另核。

本轮仅发布插件 0.0.206，Core与桌面壳未修改。版本、源码与锁经PR进入main后才构建发布；尚未发布。发布技能为本机local_draft，没有已登记团队维护源，不声称团队技能已同步。完整主线SHA、候选、CI与最终发布身份由PR及发行回执绑定。
