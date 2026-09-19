---
name: GEA Workbench
description: A clear, cautious evidence workbench built on the light Arco interface.
colors:
  arco-operation-red: "rgb(245, 63, 63)"
  api-log-red: "#d92d34"
  api-log-red-soft: "#fff1f1"
  canvas: "#f9fafb"
  surface-muted: "#f2f3f5"
  divider: "#e5e6eb"
  divider-strong: "#c9cdd4"
  ink: "#202531"
  ink-secondary: "#454d5f"
  ink-disabled: "#86909c"
  success: "#166534"
  success-soft: "#edf9f1"
  warning: "#815b0b"
  warning-soft: "#fffaf0"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.api-log-red}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "34px"
  button-outline:
    backgroundColor: "#ffffff"
    textColor: "#3b4351"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "34px"
  search-field:
    backgroundColor: "#f8f9fb"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "36px"
  filter-tabs:
    backgroundColor: "#eceef2"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.label}"
    rounded: "7px"
    padding: "2px"
    height: "29px"
  catalog-selected:
    backgroundColor: "{colors.api-log-red-soft}"
    textColor: "#9d1f25"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
    height: "36px"
  call-row-selected:
    backgroundColor: "#fff4f4"
    textColor: "#3d4552"
    typography: "{typography.body}"
    rounded: "0"
    padding: "8px 12px"
    height: "58px"
  status-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    typography: "{typography.label}"
    rounded: "5px"
    padding: "3px 6px"
  code-evidence:
    backgroundColor: "#f8f9fb"
    textColor: "#28303d"
    rounded: "{rounded.lg}"
    padding: "11px 12px"
---

# Design System: GEA Workbench

## Overview

**Creative North Star: "证据工作台"**

GEA 的视觉系统服务于判断、核对和受控操作。它继承 Arco 的浅色企业工作台语言：白色与冷灰形成连续工作面，业务红只标记当前、关键或需要确认的操作，信息优先通过结构、文字和可扫描的密度被理解。

界面应当清晰、审慎、工具化。复杂任务被组织为连续的工作路径，例如目录、记录与详情相互联动；品牌感来自精准的间距、状态和交互反馈，而不是营销式构图、装饰性动效或大面积高饱和色。

**Key Characteristics:**

- 浅色、紧凑、以连续工作面承载高密度业务信息。
- 红色稀疏地表达当前项、关键动作和风险确认。
- 文字、图标与低饱和底色共同表达状态，不依赖颜色单独传意。
- 保留来源、环境、时间和关联标识，让证据链连续可读。

## Colors

色彩以纸白和冷灰为底，红色负责操作强调，成功绿与警示金只在明确状态中出现。

### Primary

- **Arco 操作红**：现有业务工作台的主要交互色，来自 Arco 红色体系的第六阶，用于当前步骤、关键操作和焦点。
- **日志强调红**：接口日志局部扩展的收敛强调色，用于入口、选中轨道和返回工作台等主要动作。
- **日志浅红底**：与日志强调红配对，仅用于选中、错误或轻量提示的低饱和背景。

### Functional States

- **成功绿与浅绿底**：用于成功、实时开启等肯定状态；必须同时带有文字或图标。
- **警示金与浅金底**：用于幂等写请求确认、重发来源等需要停顿判断的状态，不与普通主操作竞争。

### Neutral

- **纸白画布与浅灰工作面**：纸白承载操作区，浅灰画布区分应用背景，静止状态避免依赖阴影。
- **分隔灰与强分隔灰**：细分隔线组织工具栏、分栏和表格；强分隔只在需要更清楚边界时使用。
- **冷灰墨色**：正文使用近黑墨色，次要说明使用中灰，禁用状态使用更浅的灰度。

### Named Rules

**The Sparse Red Rule.** 红色只服务于当前、关键和风险，不把整屏变成品牌色展示面。

**The Redundant Status Rule.** 状态颜色必须与文字、图标或形状至少一种共同出现。

## Typography

**Display Font:** 系统无衬线字体栈（优先 Apple / Segoe UI / PingFang SC）  
**Body Font:** 系统无衬线字体栈（优先 Apple / Segoe UI / PingFang SC）  
**Label/Mono Font:** 接口、路径、方法与代码使用系统等宽字体栈（ui-monospace / SFMono-Regular / Menlo / Consolas）

**Character:** 字体选择保持原生、可靠和快速加载。层级主要依靠字号、字重和空间建立，不用夸张字形制造视觉身份。

### Hierarchy

- **Headline**（600，18px，1.25）：工作区和详情主标题，允许轻微负字距以保持紧凑。
- **Body**（400，14px，约 1.6）：业务说明、正文和常规输入内容。
- **Title**（600，13–14px，约 1.3）：分栏标题、记录名称和局部小节标题。
- **Label**（600，11–12px，约 1.4）：状态、计数、字段名和工具栏信息。
- **Code**（700 或 400，10–11px，约 1.55）：HTTP 方法可加粗，路径、请求响应和关联标识保持等宽并允许断行。

### Named Rules

**The Scan Before Read Rule.** 先用标题、方法、状态与数值形成扫描路径，再用正文解释细节。

## Layout

界面以占满宿主高度的连续工作面为基础。顶部工具栏高度紧凑，主体通过边界清晰的分栏、表格或列表承载任务，不把每项信息拆成独立悬浮卡片。常用间距形成 4、8、12、16、20px 的紧凑节奏。

接口日志扩展体现了可复用的证据型布局：桌面端使用目录、记录、详情三栏，基准宽度分别为约 260px、弹性中栏和 360–430px 详情栏；在 1100px 以下将详情移至下方，在 680px 以下退化为单列页内详情。窄屏仍保留同一信息顺序，不用模态框抢占上下文。

**The Continuous Evidence Rule.** 有来源关系的内容保持在一个连续工作区内，让选择、记录与详情能同时被理解。

## Elevation & Depth

主体默认平面化，主要依靠白色与浅灰色调层级、1px 分隔线和选中轨道建立深度。接口日志从 DSH 设置侧栏进入，打开后作为独立主页面展示，不叠加原生会话面板；登录卡片作为独立认证场景可使用更宽的环境阴影（`0 16px 64px #2935522e`）。业务分栏、记录行和详情面板静止时不使用悬浮阴影。

### Named Rules

**The Flat-by-Default Rule.** 工作面静止时保持平面；阴影只用于真正浮在宿主之上的入口或独立场景。

## Shapes

形状语言是轻度圆角而非胶囊化。常规按钮、搜索框和列表选项使用约 8px 圆角；确认框、代码证据块和局部容器使用 9–10px；大型工作台容器顶部可使用 14px。状态标签使用 4–6px 小圆角，步骤标记等有明确语义的标识才使用圆形。

边界通常是一条冷灰 1px 实线。选中记录可以用左侧 3px 强调轨道，而不是增加阴影或扩大色块。

## Components

### Buttons

**Character:** 紧凑、直接、状态明确。

- **Shape:** 常规高度为 34px，轻度圆角（8px），内部横向留白约 10px。
- **Primary:** 红底白字，只用于当前工作区最重要的提交、返回或确认动作。
- **Secondary / Ghost:** 白底灰字、1px 灰色边框；无边框幽灵按钮仅用于复制等局部辅助动作。
- **Hover / Focus:** 悬停改变文字与边框到业务红；键盘焦点使用 2px 红色外轮廓和 2px 偏移。
- **Disabled:** 降低不透明度并保留禁用光标，不制造仍可点击的错觉。

### Inputs / Fields

**Character:** 安静地嵌入工具栏，不压过结果内容。

- **Style:** 搜索框约 36px 高、8px 圆角、浅灰底与 1px 边框，图标、输入和清除动作在同一行。
- **Focus:** 容器边框转为浅红且背景回到白色；原生输入轮廓由容器焦点状态承接。
- **Placeholder:** 使用可读的中灰，不把占位符做成禁用灰。

### Navigation

**Character:** 目录与筛选都是工作区内的视图控制，不模拟营销导航。

- **Catalog:** 行高约 36px，方法、名称和计数形成稳定三列；选中项使用浅红底与深红文字。
- **Filter Tabs:** 浅灰轨道内使用白色当前项，控件高度约 29px，避免额外阴影。
- **Record Rows:** 行高约 58px，时间、方法、名称、路径、耗时和状态按固定栅格扫描；选中项使用浅红底和左侧强调轨道。

### Chips

**Character:** 低饱和、可读、永远附带文字。

- **Style:** 状态标签使用 4–6px 圆角、3px × 6px 内边距和 11px 半粗文字。
- **State:** 成功、失败、进行中和重发来源各有明确文案；背景只提供第二层提示。

### Cards / Containers

**Character:** 容器用于组织连续任务，不用于制造孤立的展示卡片。

- **Corner Style:** 小型确认或证据容器使用 9–10px 圆角；大型工作台外壳可使用 12–14px。
- **Background:** 默认白色，次级信息区使用浅灰。
- **Shadow Strategy:** 业务容器无阴影，以色调和分隔线区分。
- **Border:** 1px 冷灰边界；内部区块优先用单边分隔而不是重复套框。
- **Internal Padding:** 紧凑区通常 8–12px，详情与工作台标题区通常 16–20px。

### Evidence Blocks

请求、响应、路径和关联标识使用等宽字体。代码证据块使用浅灰底、1px 边界、10px 圆角和约 11–12px 内边距；长内容允许横向或纵向滚动，并提供明确的复制动作。内容必须保持脱敏后的原始结构，不用视觉格式化掩盖字段关系。

## Do's and Don'ts

### Do:

- **Do** 用连续分栏、列表和详情维持业务或证据链的上下文。
- **Do** 用文字、图标与低饱和底色共同表达成功、失败、进行中和警示。
- **Do** 保持 34–36px 控件、11–14px 信息字号和 8–16px 常用间距形成的紧凑密度。
- **Do** 在 1100px 和 680px 附近按实现过的顺序折叠复杂工作区，并保留页内详情。

### Don't:

- **Don't** 把证据型或联调型扩展改造成指标卡片拼接的运维大屏。
- **Don't** 引入独立品牌语言、营销式大标题、大面积高饱和色或纯装饰动效。
- **Don't** 只用颜色表达状态，或让红色同时承担普通信息、成功和警示。
- **Don't** 在页内确认足够清楚时使用抢占焦点的模态框。
