# 团队协作、错题与提交记录

多人共享 GitLab 主线、技能和错误经验；本机工作树、安装副本、客户端是独立状态。Git 历史是提交记录的事实来源，这里补充改动原因与验收证据。

## 首次使用

1. 克隆 GEA 源码仓库与 `dsh-plugin-releases` 到同级目录；发行库只需稀疏检出 `skills/`，不下载桌面产物。已有发行库也可通过环境变量 `DSH_RELEASE_SKILLS_REPO` 指向它；在 linked worktree 中推荐显式设置该变量。
2. 在 GEA 根目录运行 `python3 scripts/team-workflow.py install-skills --apply`。默认安装到 `${CODEX_HOME:-~/.codex}/skills`，也可传 `--skills-home`。已有差异不会强制覆盖；先比对团队源及本机修改。本机专用说明放 `references/local-*.md`，不包含在共享提交中。
3. 运行 `python3 scripts/team-workflow.py install-hooks`。配置只影响本仓库及其 linked worktree，不改全局 Git 配置；每位成员需单独执行。现有 hook/core.hooksPath 不会被替换。
4. 运行 `python3 scripts/team-workflow.py check`，两项技能均为 `current` 或 `current_with_local_notes` 才完成。新技能入口见 [SKILL.md](../../.agents/skills/gitlab-collaboration/SKILL.md)。

## 日常使用

| 时机 | 动作 |
|---|---|
| 拉取主线 | `python3 scripts/team-workflow.py sync`，只接受干净且可快进的主分支 |
| 任务分支更新 | 显式合并最新主线、处理冲突，然后运行 `check` |
| 技能不同 | 查看 changedFiles，核对本机修改后运行 `install-skills --apply` |
| 修复问题 | 搜索 `lessons/`，新增或更新同根因条目，补业务结果回归 |
| 提交 MR | 填 [提交记录](change-template.md) 和 GitLab MR 模板，记录基线与验证 |
| 发布前 | `release:preflight` 会先检查两项技能；通过后仍须满足发布技能的其他门槛 |

`post-merge`/`post-rewrite` 会在普通合并/变基后提醒技能差异，但不会撤销已完成的 Git 操作。没有新提交的 `git pull`、仅 `git fetch` 不触发这类 hook，所以标准入口是 `sync`，开始任务和发布前还要 `check`。检测失败返回非零；网络不可用是“未核验”。本工具不强制服务器分支保护，也不能阻止使用者绕过本地检查；服务器保护分支/MR 审批/CI 门禁需管理员另行配置。

## 记录方式

- [错题模板](lesson-template.md)：每个根因一个文件，保存已证实和未知的边界；问题没有真正修复时保持未解决。
- [提交模板](change-template.md)：每个任务一个文件，MR 中补候选与合并 SHA；不用一个大日志承载所有人的改动。
- 不复制真实业务数据、个人路径、凭据、机器专用配置进共享记录。
- 不在提交正文写它自身的 SHA；用 MR 或后续提交补上，避免自引用。

当前已记录：

- [确认计划量变化但 SKU 明细金额不变](lessons/2026-09-24-inline-sku-amount.md)：原始遗漏，待修复。
- [主线落后且保留已合入的旧改动](lessons/2026-09-24-stale-main-and-replayed-edits.md)：本次同步已处理，防止重复恢复旧文件。
- [同版本技能内容不同](lessons/2026-09-24-skill-content-drift.md)：使用文件摘要核验，保留本机配置。
