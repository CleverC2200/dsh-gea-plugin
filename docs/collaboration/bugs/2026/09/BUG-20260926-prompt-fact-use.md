<!-- collaboration-record
{"kind":"bug","id":"BUG-20260926-prompt-fact-use","date":"2026-09-26","title":"工具已返回成员或状态字典却被最终答复否认","module":"业务Agent","category":"功能逻辑","cause":"待定位","severity":"P1","status":"待定位"}
-->
# 工具已返回成员或状态字典却被最终答复否认

真实模型复测发现工具返回内容与最终答复不一致。分仓目录已给成员，销售aggregate.basis已给status字典，最终却声称未提供。不能只凭回答归因模型、压缩或网关，需核对最终模型可见消息。

脱敏证据：docs/analysis/prompt-v3-delivery/fact-use-counterexamples.json。该问题尚未闭环，本次0.0.127不宣传全部业务问题已修复；管理端权限未修改。
