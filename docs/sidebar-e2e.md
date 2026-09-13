# 侧栏导航验收

顶部 GEA 标识在业务工作台和 DSH 对话之间切换；左下用户头像使用 DSH 原生设置触发器。侧栏工作区、设置弹窗与会话列表由 DSH 原有插槽保留，GEA 只替换品牌、设置触发器内容和业务模式的导航内容。

Chrome 实机验证（2026-09-12，127.0.0.1:3201）：两种页面均成功打开设置 dialog，显示通用设置、模型和插件；关闭后 dialog 数量为 0；顶部往返切换后工作台 iframe 数量依次为 0、1。头像 computed style 验证为 50% 圆角；品牌背景为 rgb(237, 0, 0)，用户头像为 rgb(243, 152, 48)。没有执行审批写入或模型推理。

可重复用例位于 `tests/e2e/sidebar.spec.ts`。启动本地 GEA profile 后使用 `npx playwright test tests/e2e/sidebar.spec.ts --browser=chromium`。本轮执行的是 Chrome 连接器中的等价交互和断言，未执行该独立 Playwright runner。

自动回归：`npm test` 中的 `tests/web.test.mjs` 使用隔离的 DSH profile 和 Chrome，先通过首次启动声明，再验证登录布局、品牌样式、两端头像设置、双向切换、窄屏布局，以及已删除工具栏不再出现。外部 GEA 服务由测试夹具替代；该用例还验证按版本匹配的待办启用审批按钮、打开确认弹窗、切换其他节点仍可浏览且禁止错误审批，整个用例不发送审批写请求。`tests/notifications.test.mjs` 同样通过首次声明后验证分页、筛选、详情与权限失败。快照预览和持久化传递继续由 `tests/workbench-host.test.mjs`、`tests/verify-workbench.test.mjs` 覆盖。
