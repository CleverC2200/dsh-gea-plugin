<!-- collaboration-record
{"kind":"change","id":"CHANGE-20260926-gea-prompt-release","date":"2026-09-26","title":"GEA 0.0.127 Prompt与证据链客户端发布","module":"业务Agent与发布","status":"已发布待验收"}
-->
# GEA 0.0.127 Prompt与证据链发布

- 范围：GEA插件，非桌面安装器；任务分支codex/gea-prompt-optimization。远端主线13a35ea39570172b8eef80cde8f5895c41719322，候选包含该主线全部内容。
- 改动：按需上下文、会话身份、证据完整保存与授权续读、知识投影、预测计算边界、库存规则和重复目录保护；补齐新增Prompt/Skill打包白名单。
- 团队记录：核对主线会话过期、样例歧义、Agent选择器、桌面重提与金额展示记录，原记录保留。待审MR !161/!165/!144与取数相关，未擅自合入；!182为既往发行记录补记。
- 发布技能：团队发行库21f135a3d11bc59dcda1e78cbc2fdfb5d6eca849的17个受管理文件与本机相同，仅本机钥匙串说明额外存在；current_with_local_notes。
- 历史修复/删除审查：[本次审查](../../../../../reviews/prompt-release-20260926.md)。未删文件、依赖、接口、历史记录；旧权限、页面意图、过期停止和范围约束有回归。
- 验证：复用de4b128的实现审查及634项全量记录（630通过、3原有跳过、1UI超时；模块独立6项通过）。本次历史行为定向105项通过；版本和文件清单变更后按冻结锁同步pnpm元数据。合并后运行预检、发行构建、实际包空目录安装及启动。
- 管理端统一入口：[交接文档](../../../../../handoff/prompt-admin-coordination-2026-09-26.md)。suite891c123仅作为待审补丁，Cube与权限未修改。
- 发布边界：复杂库存取数仍不稳定，存在事实未采用、协议输出和数据模型缺口；不宣称全部业务验收通过。
- 发行操作：保留本机已重写历史的发行仓库，不fetch/pull/push该目录。独立浅克隆不支持filter且长时间无有效进展，已停止本任务只读克隆。使用GitLab文件API，更新动作携带last_commit_id，以原子提交保留其它条目，读回验证，不强推/重写历史。接口依据：[GitLab commits API](https://docs.gitlab.com/api/commits/)。
- 当前状态：版本/文件清单已准备；MR、包、频道及本地同步状态在发布后补记，当前不宣称已发布。

## 发布后补记

- MR [!184](http://100.100.6.191:20656/chenyonghao/dsh-gea-plugin/merge_requests/184)已合并，merge_commit_sha/releaseSourceSha均为da649d265289431604f8c85a7d0afd7bff944d2c。标签gea-v0.0.127固定于该源码。
- 包SHA-256：673d53e17f19085c28759cd9962639efadbc5097569e1397a13b4307ce399b39；大小2695801字节。GitLab不可变包提交1fa29e74a6c7381f9651e801697a3dc37fde868a；频道提交c5e6bf59ffb62f5e97130bb6f1d154d133363aaf。
- OSS与GitLab的dsh-0.1.6-test/stable共4份清单读回0.0.127；8个不同包URL匿名HTTP200，摘要和包内name/version一致；OSS匿名列桶403。冻结频道未改，其他插件条目未改。
- release:preflight、完整发行构建、实际tarball空目录npm ci及原生DSH启动/交互通过。没有更新用户当前桌面安装，不宣称同事业务环境已验收。
- 原本地主源码main有既有未提交改动和进程，保持a6ad4f24162f6f6b475266837f565002a26793ac；原发行main保留重写历史11125bf77cfe64ee29935da523b6fd361b1ce19f，不拉回远端历史。local_sync_blocked，未reset/stash/强推。当前任务隔离工作树与远端发行证据用于本次交付。
- 管理端资源、Cube部署和权限未变；统一交接文档包含suite891c123待审完整补丁。
