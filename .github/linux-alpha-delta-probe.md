# 临时 alpha 新红差异复放

只用于既有两条诊断分支，不进入正式 PR。原 src 与各自 c01e3950/7a4100c3 相同，固定当前 W/M 与 alpha Core5bad。沿原公开 source reader/准备生成输入，每次串行执行三个完整原测试文件authorized-cube-loop、notifications、receipt，保留全部断言和超时，不用选择器跳过父级/子级。记录原结果和既有lifecycle回执；单文件组不是完整candidate-quality。

旧FC probe停止自动push，旧回执保持。新增workflow没有更改三个测试文件或产品实现、没有延长超时或改变源码事件绑定。诊断提交与父源码分开记录。

最后通知归因只串行复放完整notifications原文件3次。每次原assert/timeout不变，每个exit与日志都保留，任何一轮失败整体失败，不能只取最后绿色。前三文件原始单次复放回执保持历史。
