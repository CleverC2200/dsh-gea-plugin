# 账号头像、复制与 MCP 资源读取

GEA 登录保留 userInfo.avatar，并通过状态接口及工作台消息传递给账号菜单；仅接受 HTTP(S) 图片地址，加载失败回退姓名首字。旧登录快照没有头像字段，需重新扫码取得。

Electron 仅允许当前工作台所属 WebContents 和同源页面申请 clipboard-sanitized-write，同时设置权限检查和权限请求处理器；其余权限保持拒绝。新增模块包含在 Electron 打包清单中。此项需要重新分发桌面壳，插件更新不会替换主进程。验证参照 https://www.electronjs.org/docs/latest/api/session 。

Agent Manage 的同服务 resources/read 工具读取查询返回的资源正文，GEA 继续负责注入当前登录元数据；DSH 本体未改。
