# 临时 Linux FC 失败诊断

本文件和 `linux-fc-probe.yml` 只用于两个现有诊断分支，正式三仓 PR 不包含这些改动。

`linux-fc-probe` 仅在 `codex/test-quality-linux-probe-before-20261013`、`codex/test-quality-linux-probe-current-20261013` 的 push 上执行。固定 Workbench e0932594fc63824e8a93207f4cc11a91645a0a44、Manage 41e46f0827d40749cf7dd21b736eed19250eb03b、rc.2 Core 639ed015397290b3745d163aafe02ffee4aa3f84。原 before/current 生产基线分别为 c01e39501cc5224fe60dc20e94f663e8805f26ca、7a4100c39a32488debff78c22ef481919ae8d2aa。

沿原 Consumer probe 的公开 source-event reader、write-hosted-group 和 prepare phase 生成冻结输入。metadata 同时记录诊断提交和原基线，并强制检查 `src` tree 未变。不运行完整 quality、contracts 或另一个 Core。

唯一原病例是 `tests/branch-stock-context-text.test.mjs` 中的 `same-warehouse loading and failure do not publish retained KPI text as current facts`。原调用、条件、超时和断言保留。正常路径只监听浏览器事件，不新增请求或等待。失败 catch 读取现场后仍抛出原错误。读现场必须在原 profile/browser 清理之前执行，不能晚注册 `t.after`。

诊断 tag 为 `[CI-FC-PROBE]`，只记录 open reply 许可字段、fixture 调用计数/Consumer/错误码、最后 context 状态、iframe src/可见性/sandbox/title/错误片段、iframe `isSecureContext` 和 `typeof CSS.highlights`、浏览器 error/warning/pageerror、公开 HTML HTTP status/content type、公开 pages/resources/GEA status 的 FC 摘要，以及配置 root 的必要文件存在性与能力声明摘要。sandbox 无 same-origin 时通过 Playwright frame.evaluate 读 iframe，不读取 parent.contentDocument。

真实 HTML 装载状态来自原请求的 response 事件。失败后的 HTML HTTP 回读只使用当时存在的 iframe 完整 src 与同一 cookie context，输出隐藏归属参数；没有实际 src 时保留 unknown，不构造省略 owner 的新 URL。

不记录凭据、请求 headers、prompt、Session 原文、SQL 原文、业务数据行或完整 DOM。文本限长并脱敏；JSON/敏感标签文本省略，只保留错误码。artifact 收集 `ci-fc-probe.json`，不上传原 case 已存在的 contexts/SQL debug 文件。

旧 `linux-consumer-probe.yml` 改为 `workflow_dispatch`，避免同一 push 再次跑已归因 APS 原病例。它的原 source-event 校验仍拒绝不支持的 dispatch；本轮不从这个旧 workflow 执行新的 Consumer 诊断，也不改写事件以绕过 reader。

准备和静态校验不证明实际 Linux runtime。必须核本次 artifact metadata、固定 tuple、原断言 verdict 与 lifecycle 后再比较 before/current。
