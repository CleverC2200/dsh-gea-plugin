# DSH 页面交互

基础版：点击输入框底部工具栏的指针图标进入选择模式，鼠标滑动自动高亮整行、表格或内容块，左键直接加入输入框。没有层级按钮、内容预览框和二次确认。发送后的消息与输入框使用相同引用名称，显示为蓝色下划线；模型仍可通过 page_reference_read 按需读取快照和对象 ID。

GEA 已内置本插件的接线。独立包可供其他 DSH 页面接入，不需要替换聊天界面。支持整行、整表及内容块；细碎文字和图标会自动归入所属区域。尚未实现拖拽框选、图表内部数据点和自动回跳。

## 页面接入

1. 在业务 iframe 内加载构建产物 `lib/page.js`。隔离 HTML 文档可以直接内联该文件，不需要网络、源码映射或放宽 sandbox。
2. DSH 客户端加载本插件后提供 `ctx.pageInteraction`。页面宿主在 iframe 和会话就绪后调用：

```ts
const dispose = ctx.pageInteraction.bindFrame({
  frame,
  sessionId,
  page: "库存看板",
  surface: "inventory",
  tool: "inventory_page_apply",
});
// iframe、会话改变或页面卸载时调用 dispose。
```

3. 业务 DOM 可用 `data-page-target` 标记目录里的元素 ID，多个 ID 用换行分隔；表格行可用 `data-page-label` 指定行名。现有 GEA 扫描器的 `data-gea-el` 也可识别。
4. 原生源代码页面可通过 `import { mountPicker } from '@cleverc2200/dsh-page-interaction/picker'` 使用 `mountPicker({describe})` 为引用补充筛选范围。点选只提取可见内容，不读取 React 源码或整页状态。

## 现有页面操作

`./bridge` 导出页面目录、工具注册、队列、超时取消和回执等公共实现。GEA 旧 `src/page-bridge` 路径保留兼容出口，业务权限与执行 Adapter 没有迁入插件。

引用本身不会点击业务按钮。选择模式中点击用于选取，Esc 或“退出选择”恢复页面操作。发送时只保留短引用编号与名称。快照按会话保存在 Host 中，模型读取时才能拿到内容和元素 ID。删除输入框中的引用后，该快照不会随问题发送。引用是采集时的快照；后续动作仍由现有目录和业务接口判断。Host 重启或会话销毁后，尚未读取的旧引用需重新选择。

## 开发与打包

在仓库根运行 `pnpm build:page-interaction`。GEA 的 host/client/workbench 构建也会准备该包。

独立包可在本目录运行 `npm pack --ignore-scripts` 生成本地 tarball，通过 DSH 的本地插件安装方式加载。GEA 内置形态与独立形态二选一，避免重复装载。没有创建远端仓库或更新发行频道。

选择引擎来自 MIT 许可的 React Grab 0.2.0，仅使用 `primitives` 命中能力。公共页面桥沿用本仓库 Apache-2.0 许可。构建文件保留第三方许可注释；完整第三方许可见 THIRD_PARTY_NOTICES.md。

标准宿主自动使用输入框底部工具栏入口；非标准宿主可调用 `ctx.pageInteraction.mountTrigger(container)` 把入口放入自己的工具栏，返回卸载函数。没有挂载宿主入口时，独立页面仍使用原浮动入口。

发送、待确认和排队消息都使用同一显示投影；只调整文本节点显示，不改模型记录或原生复制动作。名称中的方括号、斜杠等字符无损保留。

GEA中的工作台使用统一接线：原生审批、PrototypeWorkbench承载的计划原型，以及所有注册的HTML工作台。新原型页复用PrototypeWorkbench即可获得入口及会话绑定；HTML页面由Host统一内联离线选择器，不需要各页面再加按钮。

默认通过原生 `conversation.input.left` 自动挂载，无需每个工作台另加按钮。按住 Alt 临时选择，松开退出；工具栏点击开启持续选择，Esc 退出（再次点击也可退出）。已经左键确认的引用不会因为松开 Alt 丢失。`mountTrigger` 保留给非标准宿主使用，标准 DSH 输入框不应重复调用。

宿主集成可向 `apply(ctx, { authorize })` 提供同步写入校验；`clear` 和卸载会取消尚在读取请求体的保存操作。HTML 承载器通过 `referenceLease` 传入当前租约，该字段只参与写入校验，不进入已保存的引用。点击时先检查页面 ready、可见和允许引用，并冻结当时的内容、范围与时间。后续编辑或隐藏列不改写该快照。范围字段仍限制为1000字符。

点选承载器先读取 `/api/page-interaction/binding` 的当前引用代次，配置完成后才允许采集；保存时附带该代次。清空后，旧代次的请求即使尚未到达服务端，也不能重新写入。代次不替代宿主授权或HTML页面租约，失效请求不自动重放。

引用请求由父页持有一次5秒超时，覆盖唯一一次 Host 授权保存和输入框插入；超时、取消、卸载均清理等待。原位 load 会中止尚未插入的请求并提示，不删除已插入引用。保存响应返回后读取既有绑定代次，再检查当前 Session 与页面绑定，防止跨身份迟到的响应插入旧引用；这次只读检查不重新保存或修改快照。已保存快照保持不可变，实际业务动作仍按当前权限与数据重新校验。

GEA 的 HTML 承载器把工作台 Session 关联到 Host 当前登录代次，打开页面时也必须提交该代次。注销、切换租户或环境后，Host 撤销页面租约、引用和页面工具；客户端观察到新代次时立即卸载旧 iframe、取消待处理引用与页面请求，迟到的旧响应不写进新页面。Host 已在旧身份下确认成功的引用随后仍可被注销撤销，旧引用读取会返回 `REFERENCE_UNAVAILABLE`。浏览器与 Host 的身份通知有传输时差，页面不把一次确认响应当成跨进程永久授权。
