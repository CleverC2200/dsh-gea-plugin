# 项目 Issue 跟踪

本项目使用 GitHub 仓库 CleverC2200/dsh-gea-plugin。规格和执行票使用 ready-for-agent 标签，只有阻塞票完成后才能开始执行。读取正文与评论使用 gh issue view --json body,comments；发布正文使用 --body-file。任务之间使用原生 blocking 关系，规格与执行票使用 sub-issue 关系。

纠偏审批规格：#26；执行任务：#27–#33。本轮审查基线为开工前提交 b46dc42fe509be9cd703ee842a7994e7f7087c10，工作在当前 codex/gea-save-guard 分支提交。
