# GEA 串行合并

本入口是待部署候选。源码、本地回归与 artifact 探针不能替代受保护合并验收。先完成 S1 的 04 完整对照和 06，再由 root 审查、批准并将部署代码合入 main，配置环境及规则，最后在单独获准的演练 PR 上验证。#197、#202 保持不自动合并；当前策略明确拒绝这两个 PR。

## 启用前

只允许 `CleverC2200/dsh-gea-plugin` 的同仓 PR，目标为 main。固定身份、预算及来源路径由 [serial-merge-policy.json](../scripts/serial-merge-policy.json) 维护。部署必须同时满足以下条件。下列非敏感变量使用 repository variables，确保 job 准入条件能在启动前读取；私钥只放限定 environment。

- `gea-serial-merge` environment 仅允许 main。私钥只保存为该 environment 的 `GEA_MERGE_APP_PRIVATE_KEY`，不放仓库级 secret、不传给 PR workflow 或个人 Codex。
- 配置 `GEA_MERGE_APP_ID`、`GEA_MERGE_INSTALLATION_ID`，与策略中已核实的 App/installation 一致。App 仅选择 GEA。每次 installation token 又显式限定 `repositories: ['dsh-gea-plugin']` 及现有四项权限，不因未来 App 安装范围扩大而扩大令牌。
- 保留 main 的 strict/admin 保护及来自 GitHub Actions App15368 的 `candidate-quality`。专用合并 App 不加入质量或 review 绕过名单。
- 建立仅限制 main 更新的 active branch ruleset，规则为 `update`，`parameters.update_allows_fetch_and_merge=false`，唯一 bypass 为专用 App 的 `pull_request` 模式。将实际规则 ID 写入 `GEA_MERGE_RULESET_ID`。其他普通合并入口受该规则限制。运行器会在每次写入前核对这些条件。参数含义见 [GitHub rules REST](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset)。
- 首次部署 workflow 到 main 后，读取其服务端 workflow ID 并冻结为 `GEA_MERGE_WORKFLOW_ID`。运行器和历史恢复都校验该 ID。删除重建 workflow 前先对账旧历史；更换 ID 需另行审查迁移，不能作为清空 unknown 的手段。
- 最后配置 `GEA_MERGE_ENABLED=true` 才接收实际请求。当前代码没有配置这些部署项，也没有启用写入。

App 只授 Contents/PR write、Checks/Administration read，Metadata 默认 read。workflow 自身 `GITHUB_TOKEN` 仅有 contents/actions read，负责运行与 artifact 查询。原生 artifact 上传使用 Actions runtime 凭据。App JWT、installation token 和私钥不写入回执或日志。

以下参数仍需启用批准。候选值是活动预算 45 分钟、轮询 10 秒、job 55 分钟、artifact 保留 30 天、最多检查 1000 个历史 run。并发组固定为 `gea-serial-merge`，`queue:max`、`cancel-in-progress:false`。GitHub 原生队列不承诺严格入队 FIFO；超过原生容量、平台拒绝或取消的请求需要人工处理，不自动重提。

## 请求与回查

各人的 Codex 完成开发、审查并取得准确 source head 的初次正式 `candidate-quality` 成功后，只提交一次绑定 SHA 的请求。入队不覆盖原有“先别合并”限制；未经合并批准的候选不能提交。

```sh
gh workflow run serial-merge.yml --repo CleverC2200/dsh-gea-plugin --ref main \
  -f operation=enqueue -f pr=获准PR号 -f head=完整40位sourceSHA
```

请求身份来自 GitHub run actor/ID 和仓库权限，不能通过输入自报批准。request ID 是该控制器 run ID。PR 号或 head 错误、head 初次门禁红灯或未完成会快速结束，不先同步、不占满等待预算。只识别固定 source-quality workflow 的正式 required check；后续 metadata-only run 不能覆盖该 head 已有正式失败。排队期间 main 前进时，执行代码仍 checkout dispatch 的 `github.sha`，当前目标 main 由 API 独立读取。

轮到后才调用 `update-branch(expected_head_sha)`。新 head 需要独立通过门禁，旧绿灯不能复用。App 来源证明同时核固定 bot numeric ID、原始首轮 run 的 actor/created_at、准确新 head、有序双父提交、PR/分支/仓库及固定 source-quality workflow；重跑者 `triggering_actor` 和 commit author 不提供来源证明。

该来源证明要求 App 私钥只归上述 main environment，且 App 只通过本入口的 update-branch/merge 两个端点写入。该 App 不能另用于 title/body、reopen、labels/comments 等动作。管理员或密钥持有者绕过此部署边界另做 App 写入，不属于防普通作者并行 push 的模型。来源缺失或冲突会暂停，正常 App 更新是否实际产生符合这些条件的 run 仍须 hosted 演练。

每次 API 写入前先成功上传并确认原生 artifact 意图，再发送一次写入。合并使用准确 head 的 `merge(sha)`，之后回查 merged/head/merge commit。普通 CI 失败、可确认的 API 拒绝、检查等待超时会结束并释放。响应丢失、可能已发出的写入或不能确认的更新/合并保持暂停，后续请求不能绕过。

## 暂停、取消与恢复

暂停新请求时将 `GEA_MERGE_ENABLED` 设为 false。在途 run 已捕获配置，需另用 GitHub 原生 Cancel 取消。仅有 `cancel-in-progress:false` 不代表禁止用户取消。在写前取消可结束；意图已持久化后被取消，即使请求可能尚未真正发出，也保守保留未知状态。

maintain/admin 在核对原 request ID 后，只执行恢复入口。

```sh
gh workflow run serial-merge.yml --repo CleverC2200/dsh-gea-plugin --ref main \
  -f operation=recover -f recovery_request_id=原控制器runID
```

恢复先读取同一可信 main workflow 的历史 run/attempt 和 artifact。每个宿主 SHA 还须由服务端明确 `refs/heads/main` 的当前 commit 证明相同或祖先关系；分支字符串、同名 tag 或仅 owner/run 自洽不提供源码归属。main 前进允许旧可信快照，来源读取失败或比较未知仍闭锁。它只回查旧写入，不重发未知 update/merge；确认更新来源后可按原候选继续检查。恢复不批准作者并行 push 的替换 head。普通新请求不能借 recover 输入绕过请求身份或原 head。

历史缺失、过期、内容归属错误、分页未完成或多笔未知均拒绝新写入。没有实际执行的 queued/skipped attempt 只有通过完整 jobs 元数据证明无 runner/steps 才可跳过。保留期到期后不得直接删证据或设置“忽略旧 run”；需先人工保存并审计可回读的终态证据，再另行审查恢复方案。当前候选不提供清空历史或强制放行开关。

## 原生 artifact 协议探针

独立实验分支 `codex/gea-ci-s1-artifact-probe-20261024` 的 push 触发 [artifact probe](../.github/workflows/serial-merge-artifact-probe.yml)。它不使用合并 environment、App 私钥或仓库写 token，使用与生产相同的 SDK 锁和适配器。首次普通提交验证 upload 和 API 可见；第二次提交首行用 `serial-artifact-read:首次runID` 验证跨 run download；consumer 按同样方法核对服务端明确的实验 heads 分支及 producer 祖先关系。不得把本地夹具通过写成原生协议通过。

启用前仍需 root 执行该短探针，并在获准的独立演练 PR 上验证 202 的 App actor/父提交/门禁、多个排队请求、普通失败释放、取消和未知响应恢复，以及最终 main CI。部署代码合入 main 的批准与演练 PR 的合并批准分开记录；候选 PR 不自动合并。

## 只读控制器

`scripts/serial-merge-controller.mjs` 每次读取一个请求及 GitHub 状态，返回下一步决策和新状态。两种命令都只演练，没有更新分支、合并、创建 App、配置 secret 或修改规则的执行路径。它不 checkout PR，也不运行 PR 代码。

```sh
node scripts/serial-merge-controller.mjs --fixture scripts/fixtures/serial-merge-controller.json
node --test scripts/serial-merge-controller.test.mjs
node scripts/serial-merge-controller.mjs --github /absolute/request.json
```

输入结构见 fixture。`state` 保存 `queue`、`active` 和 `finished`；`policy.approvals` 逐项绑定请求的 `id`、`repository`、`pr`、完整 `head`、`base` 和 `actor`。这里的 approval 是演练输入，不能替代实际人类授权。`--github` 使用已有 `gh` 认证，并核当前登录账号与请求操作者一致；输出仅含非敏感状态，不读取或输出 token。

演练队列按 `enqueuedAt`、请求 ID 排序，容量包含在途项。样例容量为 20，单项等待预算为 45 分钟，属于待批准的演练参数。超额、重复及取消请求留下结束回执，不静默覆盖。恢复时将输出的 `state` 作为下一次输入；`finished` 必须保留，避免同一请求 ID 重放。普通失败后重提需要新的 ID 和对应许可。

本地演练排序不代表 Actions 原生等待顺序，也不自动保存队列或定时唤醒。真实入口使用上文的原生并发与 artifact 恢复。

| 状态或观察                             | 决策与后续                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未许可、草稿、fork、错误 base、旧 head | 结束当前项，不建议写入                                                                                                                               |
| 排到且落后于 main                      | `would_update`，绑定 `expected_head_sha` 与已观察 base；演练状态进入 `updating`                                                                      |
| 等待更新                               | head 未变则等待；新 head 必须只有原 head 与观察 base 两个有序父提交，并与许可中的 `updatedHead` 相等；缺少新 head 许可则暂停，未知响应遇到异常仍暂停 |
| 等待检查                               | 只接收冻结 head、指定 App 的最新 required check；失败结束，缺失、旧绿灯、排队或跳过继续等待                                                          |
| 检查成功                               | 要求 strict、管理员受约束及非空 App 绑定 required checks，再重查 head/base，输出带准确 `sha` 的 `would_merge`                                        |
| 合并响应未知                           | `reconciling` 持有槽位，只读回查；准确 head 已合并且存在 merge commit 才结束；未确认、读取失败、超时或取消均不释放                                   |
| 普通失败或等待超时                     | 结束当前项，下一次调用可选择后续请求；已受理更新在超时后仍无法确认时暂停                                                                             |

`would_update` 和 `would_merge` 只表示模拟写入边界。下一次夹具调用可以从返回状态模拟异步结果；真实只读命令不会执行该决策。`active.outcome = "failed"` 表示夹具中的已确认失败，`"unknown"` 表示响应未知，不能把未知写成失败以释放槽位。

GitHub 只读入口仅使用固定 GET 端点并读取完整检查分页，不输出任意 API 响应正文。夹具的 `updatedHead` 是显式模拟批准；生产 runner 复用此决策，同时按上文来源证明生成对应许可。只读决策通过不能代替真实唯一写入规则、App 来源和受保护合并验收。
