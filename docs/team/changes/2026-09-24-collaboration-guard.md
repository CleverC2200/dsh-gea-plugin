# 2026-09-24：共享协作技能、错题本与拉取检查

- 目的：多人通过 GitLab 协作时保留最新主线和本机未提交内容，共享已经发生的错误，避免各机器技能规则不同。
- 仓库：chenyonghao/dsh-gea-plugin；分支：codex/team-collaboration-guard。
- initialBaseSha / 合入前最新主线：`11412c7783e2c8438a4db6c4a0e36d39cb89d1e6`。
- 关联错题：`../lessons/2026-09-24-inline-sku-amount.md`、`../lessons/2026-09-24-stale-main-and-replayed-edits.md`、`../lessons/2026-09-24-skill-content-drift.md`。
- 改动：新增 gitlab-collaboration 技能、来源清单、文件摘要检查/受保护安装/快进同步/仓库 hook 安装器；新增错题与提交模板、GitLab 默认 MR 模板；AGENTS 和 release-preflight 接入双技能检查。
- 差异核对：只涉及协作工具、文档和发布前置检查；没有更改业务组件、包版本、依赖、锁文件、频道或桌面代码。
- 验证：`python3 tests/team-workflow.test.py` 12 项通过；skill-creator quick_validate 通过；`node --check scripts/release-preflight.mjs` 与 `git diff --check` 通过。临时仓库测试验证同版本内容漂移、脚本变化、本机修改保护、本机说明保留、脏工作区/分叉保护、真实 pull hook、无更新时检查和符号链接拒绝。
- 首次在线核验：发布技能来源 `2dc96f7f412fd12f0952d4eba0ed309f36512c13`，本机 SKILL.md 有机器说明引用差异；新协作技能在合入前返回 unverified，未把本地草稿冒充远端最新。合入后安装与最终在线核验结果记录在 MR。
- 限制：hook 需要每位成员安装，不是服务器强制策略；普通无更新 pull 不触发 post-merge，须使用 sync/check。技能改动安装后须重新读取入口。发布检查不替代服务器分支保护或真实业务验证。
- 恢复：技能安装保存原目录备份；已有 hook 不覆盖；协作工具不自动 stash/reset/强推。金额错题仍待修复。
- 候选 SHA / MR / 合并 SHA：由本任务 GitLab MR 记录，避免提交自引用。
- 发布状态：未发布插件、桌面或独立技能归档包。
