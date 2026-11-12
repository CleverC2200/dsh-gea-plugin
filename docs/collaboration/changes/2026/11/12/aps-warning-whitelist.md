<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261112-gea-warning-whitelist","date":"2026-11-12","title":"GEA预警白名单与调度接线","module":"产销协同","status":"验证中"}
-->

# GEA预警白名单与调度接线

Host 新增受当前登录与 APS 授权保护的预警存储及调度接口。四张预警业务表的 CRUD 使用 PG-Warning 的 `/ai/sql/execute` 通用白名单，固定表字段与命名参数；不将写入发送到只读受控网关。保存核对精确归属、版本与逐条更新回执，不回退数据库直连。

独立执行器部署在现有 XXL-JOB 服务器，客户端使用 `https://gea.synear.cn:4443/gea-warning/client`。服务器核验 GEA 身份与 APS 授权，限制当前所有者调度任务；XXL-JOB 的执行协议只监听本机，不对外代理。用户确认沿用登录客户端执行 Agent 的逻辑，无人在线不能伪造成功。

计划组合：Workbench 0.1.107、Manage company.69、GEA 0.0.284；Manage 复用已发布同版归档，保留最新主线其他修复。4项存储边界回归和真实白名单新增、编辑、软删除、运行/事件/观测回读、幂等与冲突拒绝已通过；HTTPS、调度注册、创建、重复保存及停用已验证。完整客户端检测及发布验收另记，当前不宣称完成。
