<!-- collaboration-record
{"kind": "change", "id": "CHANGE-20260927-gea-inventory-recovery-130", "date": "2026-09-27", "title": "GEA 0.0.130 全链库存Skill参数恢复与超时诊断", "module": "全链库存与模型流", "status": "已发布待验收"}
-->
# GEA 0.0.130

- 发布授权：用户要求“改动先发一版吧”；只发布当前修复的GEA插件，不发布桌面、管理端或其它插件。
- 初始开发基线688991d3e0b20efa035acbc14ee3c9337bfdb1a5；发版前刷新并整合最新主线72c6ea10a89c017ea03ae30ada57ffd70ebdadff，完整保留0.0.129页面引用及0.0.128业务查询改进。
- 已同步同事0.0.128/0.0.129发布记录，查看当前Bug索引及Skill、模型流、打包相关历史；待审MR !182/!165/!161/!160/!144/!125/!124/!117均不混入。
- 本轮问题：[Skill误填](../../../../bugs/2026/09/BUG-20260927-skill-paging-path.md)、[模型超时诊断](../../../../bugs/2026/09/BUG-20260927-model-total-timeout.md)。
- 无文件、功能、接口、依赖、测试或历史记录删除；既有授权、路径、预算、取消及协议保护保留。审查见 docs/reviews/inventory-recovery-release-20260927.md。
- 发布技能团队基线02fda54ededa65e53942e0b1bbf9220db48954dc，17个受管理文件与本机一致，仅额外本机钥匙串说明，current_with_local_notes。
- 0.0.128基线40项针对性测试、类型检查和Host构建通过；本次整合最新主线后重新验证，实际命令与结果见后续补记。依赖/打包规则相对0.0.129不变，复用该版安装验收，仍重建与核验包内容。
- 发行库通过GitLab文件API与last_commit_id维护，保留本机发行库重写历史，不fetch/pull/push该目录。主源码目录的其他任务修改保留。
- 未发布。源码MR、标签、固定包摘要、频道读回和本地同步边界发布后回填。实际同事账号问答与超时根因仍待验收。

## 候选验证

- 最新主线整合后，冻结 pnpm 安装、类型检查和完整构建通过。
- 67项针对性回归全部通过，无跳过：原始错误参数、真实 Harness 恢复、模型总时限、用户取消、身份失效、旧 DSML 防护、页面引用、双锁和 Cordis 一致性。
- 相比0.0.129，依赖、入口、包文件清单不变；仅根包版本及 shrinkwrap 根版本递增。

## 发布后补记

- [MR !190](http://100.100.6.191:20656/chenyonghao/dsh-gea-plugin/merge_requests/190)已合并，merge_commit_sha与发布源码均为 `3d0e2b409c04ccb9bd77ae99b792bae351b7abfb`；标签 `gea-v0.0.130` 固定于该源码。
- 包2813276字节、52个文件，SHA-256：`c190d375891098b5384c662218a965fdd44de4bbb9271982ec30e67b8f2fcae9`。与0.0.129包文件清单、依赖及入口相同，确认修复后的Host和全链Skill在包内。
- GitLab不可变包提交 `698dd05aee8a960be5f71cb836cb5a8f434b6d46`；频道提交 `37a38fe2d3819b2d40363ee671cae7342f6663ee`。OSS使用相同字节与摘要。
- GitLab与OSS的DSH 0.1.6测试/正式共4份清单均为0.0.130；8个不同包URL匿名HTTP 200，包名、版本和SHA一致；其他插件原样保留，GitLab旧test/stable频道字节未变。匿名列OSS桶403符合预期。
- 单文件PUT接口返回EOF后先读回确认未写入，再用带last_commit_id的提交API原子更新两频道；未覆盖并发变更。
- 合并后发行预检、完整构建和包白名单/内容核验通过；未更改用户当前安装或重打客户端。
- 本机源码主目录有其他任务未提交改动；发行主目录保留已重写历史，不做fetch/pull/push。两者均保持原样，`local_sync_blocked`；发行完成与本地同步分开记录。
- [完整发行证据](../../../../../releases/gea-0.0.130-verification.json)。源码主线增加本次发布记录时，不移动标签或替换包。

- Independent distribution verification JSON upload returned HTTP 502 and readback confirmed no file was created. The complete receipt is stored in the source repository at the link above; package and channel publication remain verified.
