---
version: 1
slug: "src-workbench-api-log-center-tsx"
primary_target: "src/workbench/api-log-center.tsx"
related_targets: ["src/workbench/page.tsx", "src/workbench/workbench.css"]
---

# GEA 接口日志中心

## Scope

主工作台内的本地扩展，visitor mode 为 Operate。面向开发和联调人员，完成接口发现、调用核对、错误定位与受控重发；不改变现有销售计划业务工作台的视觉身份和业务流程。

## Confirmed task

接口目录与调用记录左右联动，记录真实 Host 上游调用。最多保留 500 条，自动脱敏；只读请求可重发，幂等写请求二次确认后复用原请求体、请求 ID 和幂等键，身份或环境变化后旧记录不可重发。

## Direction contract

THESIS: 这是嵌在业务工作台里的网络观测台，核心是“接口定义—真实调用—请求响应证据”连续可读，拒绝把它做成指标卡片拼成的运维大屏。

OWN-WORLD: 继承现有 GEA 与 Arco 的浅色工作台，使用克制中性色和现有红色操作色。主体是紧凑目录、时间序列记录和结构化正文三栏；状态依靠文字、图标和低饱和底色共同表达，不新增独立品牌语言。

STORY: 用户先在接口目录确认能力和重发规则，再从调用流定位一次请求，最后核对脱敏后的请求、响应、耗时和关联 ID；满足规则时在详情区完成复制或重发，然后看到一条带来源关系的新记录。

FIRST VIEWPORT: 已认证工作台右上角提供“接口日志”入口。打开后切换为完整工作区：顶部固定搜索、实时刷新、刷新与清空；左侧约 260px 接口目录，中间为可扫描的调用序列，右侧约 420px 展示请求和响应。窄屏退化为单列和页内详情，不使用需要抢占焦点的模态框。

FORM: 选择“嵌入式网络观测台”作为本地扩展结构，不开启整页概念竞赛；seed key: local-extension-no-roll。签名交互是接口目录、调用记录和详情三者的即时联动，以及重发后原记录到新记录的可追踪关系。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved decisions

暂无。持久化、导出原始凭证、任意编辑请求和跨身份重放均不在首版范围。
