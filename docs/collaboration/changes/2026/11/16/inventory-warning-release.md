<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261116-dsh-gea-plugin-inventory-warning","date":"2026-11-16","title":"预警人员搜索 Host 接线与组合 0.0.294","module":"库存与产销协同","status":"待发布"}
-->

# 预警人员搜索 Host 接线与组合 0.0.294

补注册既有预警页面请求的 people/search 路由，沿当前 GEA 登录与 APS 准入调用固定的用户选择组件接口。仅返回已启用内部人员的账号、姓名与部门展示字段；姓名和登录名均可搜索，保留租户权限、取消代际和结构化错误，不接收调用者的服务器地址或身份凭据。

兼容组合新增 Workbench 0.1.116、Manage company.76；不删除既有兼容范围，不升级 Core，不改 SQL 授权或通知发送规则。当前主线预警白名单 CRUD、XXL-JOB 与客户端运行逻辑保留。相关未合入的发布记录不被当作主线事实。

已验证真实目录的姓名/账号查询、Host 路由和 Workbench 桥接的回归；接收人选择的独立浏览器检查不发送通知、不保存任务。正式插件安装与页面复测在发行回执中另记。

发布技能为用户已批准的本机 1.3.0 local_draft，未登记团队维护源；沿 GitHub 源码、现有三包工具和 OSS 频道执行，不触发旧 GitLab 流程。
