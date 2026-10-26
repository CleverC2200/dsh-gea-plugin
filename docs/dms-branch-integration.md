# 分仓 DMS 暂存对接

契约来源：[DMS × AI 订单对接接口文档](https://klvcodtump.feishu.cn/docx/BdnOdGzSfoFY4mxTP1zcUxVonyb)，2026-10-23 读取 revision 8。

分仓补货页面的提交预览支持填写客户、收货地址和提货点编码，核对数量后暂存至 DMS。数量为件；默认速冻、配送、不拼车、同意缺货分批到货。现有 Excel 导出继续保留。暂存不是审核或推送 SAP/OMS，只有成功且预订单号匹配的回执才展示 DMS 订单号。草稿在暂存后保留。

## Host 配置

GEA Host 配置增加可选 `dms.test` / `dms.production`，缺失当前环境或唯一用户映射时拒绝执行。测试网关地址已按接口清单补齐；管理端地址及账号映射仍是占位符，必须替换为实际部署值。账号映射只由部署管理员提供，不能由页面填写。

```json
{
  "dms": {
    "test": {
      "gatewayUrl": "http://100.100.1.147:8000/synear_test/DMS",
      "manageUrl": "https://dms-manage.example.invalid",
      "secretEnv": "GEA_DMS_TEST_SECRET",
      "users": [
        { "tenantId": "GEA租户ID", "userId": "GEA用户ID", "username": "对应DMS用户名" }
      ]
    }
  }
}
```

登录账号也可配置 `workcode`；两者同时存在时按文档优先 username。启动 Host 的进程环境提供密钥变量，不把密钥写进页面、仓库或聊天。配置用户名必须具有所需 DMS 业务权限，真实权限继续由 DMS 校验。配置该映射即显式开放该用户的分仓 DMS 动作，不会提升通用 HTML 模型工具的影响等级。

`gatewayUrl` 支持部署路径前缀，末尾拼接文档固定路径。`manageUrl` 用于校验跳转来源；凭据请求不跟随 HTTP 重定向。独立 DMS 传输不进入通用请求正文日志，以免记录签名、票据或令牌。

## 三个接口与边界

- `POST /auth/oauthout/ssoLogin`：Host 用 `MD5(key + time + secret)` 小写摘要和 form 内 JSON `ssoToken` 登录，`source=ai`。
- `POST /dms/order/dmsOrderHead/submitZcOrderDirect`：Host 校验订单并携带 Bearer 凭据，回执只投影订单号和预订单号。
- `GET /auth/oauthout/getOauth2Token`：Host 适配器提供 key/menu 兑换方法并有离线测试。当前页面使用 DMS 返回的 `/user/loginSSO` 跳转页，由 DMS 页面调用取参接口完成登录；GEA 不接收原始 OAuth2 map，也不预先消耗跳转票据。

Workbench 通过当前页面 owner 的专用 `branch-dms` 操作调用可选 grant；只有非 mock 的 `inventory-fc` 适配器提供该 grant。Host 重新核分仓资源启用、GEA 登录和环境用户映射，所有调用绑定页面及身份取消信号。其他页面没有这个能力；通用 HTML action/模型工具仍保留原只读限制。

当前主数据未提供客户与分仓/收货地址/提货点的可信映射，所以页面要求显式填写编码，不用仓名或分仓编码猜提货点。此次没有新增或修改 SQL。

## 重复提交与结果未知

DMS 文档没有承诺幂等。页面按月份、分仓及已排序订单正文生成稳定意图号，Host 再按环境/租户/用户转换为全局预订单号。同一用户、同一月、同一分仓和同一订单内容重复提交会回读原成功结果；这不是允许重复建同内容订单的入口。

Host 在 `runtimeDir/dms-orders/` 下独占创建意图文件后才发送订单，不记录登录凭据。成功回执原子写回。并发同键、进程重启、超时、异常回执或业务失败都不会自动重发；改变已占用意图号的正文也会拒绝。结果未知时须凭提示中的预订单号在 DMS 核查，不能通过修改字段或生成新号规避；当前接口文档没有查单/安全补偿接口，因此不提供自动解除未知状态入口。

## 验证状态

启动配置转换已透传 `dms` 到 Host，源码和 bundle 两种配置路径均有回归覆盖。本轮配置与 DMS 协议测试 15 项、分仓页面相关测试 11 项全部通过。用户确认暂时没有测试账号等凭据，因此当前交付为源码接线及离线验证，未安装发布、未完成真实登录或下单联调。

新增 Host 协议测试及分仓页面交互测试已通过，DMS 模块独立 TypeScript 检查通过。完整工程类型检查因当前 checkout 缺少官方 Core 依赖失败，尚未完成真实客户端装载及 DMS 业务联调。

2026-10-23 17:17（北京时间）读取接口表 revision 1173，确认三个分仓接口共用测试基础地址 `http://100.100.1.147:8000/synear_test/DMS`。此前地址缺少 `/DMS` 前缀，404记录不再代表新地址。

无凭据、无订单内容的路由检查结果：

| 接口 | 检查结果 |
| --- | --- |
| POST `/auth/oauthout/ssoLogin`（空表单） | HTTP 400，缺少请求参数，路径已到达后端 |
| GET `/auth/oauthout/getOauth2Token`（未传 key） | HTTP 400，缺少请求参数，路径已到达后端 |
| POST `/dms/order/dmsOrderHead/submitZcOrderDirect`（空请求、无令牌） | HTTP 200、空响应体；不是有效订单回执，不能判定成功 |

Host 已支持保留多段基础路径，无需修改接口拼接。尚未配置真实运行环境，仍需管理端地址、GEA租户/用户到DMS username或workcode的映射及本机 `GEA_DMS_TEST_SECRET` 密钥。上述检查未发送订单内容，也未证明带凭据登录和业务暂存通过。
