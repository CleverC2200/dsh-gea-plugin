<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261104-plugin-suite-130","date":"2026-11-04","title":"三插件独立升版与订单工作台跨页面缓存修复发行","module":"构建发布","status":"待发布"}
-->
# 三插件发行准备

- 本次目标：Workbench 0.1.60、Manage 0.6.3-company.52、GEA 0.0.229。源码及版本通过各仓 main PR 合入后固定，不复用已占用版本号构建新字节。
- 对比基准：已发布 Workbench 0.1.59、Manage 0.6.3-company.51、GEA 0.0.227。GEA 0.0.228 已被源码标签占用，本次继续升至 0.0.229。分配前已读取远端标签、Release、待审升版 PR、测试/正式频道及已发布客户端 manifest。
- Workbench 纳入 [PR #235](https://github.com/CleverC2200/dsh-agent-workbench/pull/235)：普通菜单切换保留页面自身 Core Session 呈现引用，通道重连保留已完成且兼容的 20 分钟周期缓存；仍取消在途请求和预览，身份、真实会话变化及过期继续清理。
- Manage 纳入当前主线的导入预览启动与完成状态说明，保持弹窗由用户确认后保存。此次不新增业务规则。
- GEA 纳入当前主线的客户端/三包协调更新、运行版本确认与既有恢复合同，并补充新 Workbench/Manage 的兼容版本声明。不顺带发布客户端或升级 Core。
- 本轮版本候选仅修改版本、对应生成常量、Workbench 根锁版本、GEA companion peer 声明及本发行记录；未删除功能、测试、依赖或历史记录，未发现本次升版引入历史修复回退。原有业务与 Native 未完成验收不因升版被标为完成。
- 已有证据：PR #235 四项 CI 成功，缓存修复 115 项本地定向检查通过；真实页面跨页返回完整回显约 0.38 秒，返回后切换另一缓存周约 0.62 秒。版本 PR、固定源码构建、三包交付、安装接收、发行预检、频道生产 reader 下载及 GitHub Release 在本轮分别留证。
- 同事记录：已读取现有协作 Bug/更新索引；Windows 安装、启动解析、旧图保留等原有待验证记录保持原状态。本轮没有发现新的业务缺陷，不创建空 Bug。
- Skill：用户提供的 dsh-plugin-release 1.3.0 分发 ZIP，已按完整文件清单 SHA-256 核对；未登记团队维护源，标记 distributed_bundle，不宣称团队技能同步。
- 本地工具边界：1.3.0 索引器拒绝一份既有历史 Bug 的分类元数据，原记录和索引未改写，本页通过发行 PR 直接引用；Windows 轻检查的旧路径映射未匹配 Core commandRoots，文档中的 Core 命令实际存在，未将其误改为插件命令。知识引用由后续 Linux CI 按原配置核验，失败回执保留。
- 发布状态：尚未上传包或推进频道。正式发布前以已合入源码创建不可移动 annotated tag 占用版本，完成当前目标组合验证；发布后链接与验证事实保存在同轮发行回执及 GitHub Releases，不移动标签或重打同版包。
