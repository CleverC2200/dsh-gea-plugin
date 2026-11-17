<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261117-category-expansion-gea","date":"2026-11-17","title":"配套品类展开编辑修复发行","module":"销售计划","status":"已发布"}
-->
# 配套品类展开编辑修复发行

[GEA 0.0.308](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.308) 已发布，配套 [Workbench 0.1.129](https://github.com/CleverC2200/dsh-agent-workbench/releases/tag/v0.1.129) 与既有不可变 Manage company.81。GEA在原精确兼容列表中增加129，更新Host/client编译版本声明。保留307及主线已有预警负责人能力。

[配套 PR #443](https://github.com/CleverC2200/dsh-gea-plugin/pull/443) 与 [Workbench修复 PR #363](https://github.com/CleverC2200/dsh-agent-workbench/pull/363) 已合入。修复候选及合并后的主线检查通过，[固定源码正式构建、预检与官方隔离安装接收](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/44042445035) 通过。test139、stable131均发布并读回，生产更新源三包实际下载、大小与摘要核验通过，两个新Release均已发布并回读。

正式Mac客户端通过内置更新器更新，安装、Host与界面版本一致。实际验证品类模式下组织行静态显示、品类独立展开编辑、多客户按原确认量比例拆分、逐客户核对与刷新恢复。原值已恢复，后台数量未变，未提交审批。重启后经已有飞书入口回到应用，未输入新凭据。Windows实机品类编辑未验证。

Core与SDK固定原输入；Manage较新主线中的依赖准备及订单指标文案不属于本轮，继续复用company.81归档。首个频道写入前两仓新增内容仅为并行预警版本的验收文档，核对后保留已固定的产品源码标签。未覆盖旧归档、标签或其他发布记录。
