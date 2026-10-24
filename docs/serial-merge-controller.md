# 串行合并只读演练

`scripts/serial-merge-controller.mjs` 每次读取一个请求及 GitHub 状态，返回下一步决策和新状态。两种命令都只演练，没有更新分支、合并、创建 App、配置 secret 或修改规则的执行路径。它不 checkout PR，也不运行 PR 代码。

```sh
node scripts/serial-merge-controller.mjs --fixture scripts/fixtures/serial-merge-controller.json
node --test scripts/serial-merge-controller.test.mjs
node scripts/serial-merge-controller.mjs --github /absolute/request.json
```

输入结构见 fixture。`state` 保存 `queue`、`active` 和 `finished`；`policy.approvals` 逐项绑定请求的 `id`、`repository`、`pr`、完整 `head`、`base` 和 `actor`。这里的 approval 是演练输入，不能替代实际人类授权。`--github` 使用已有 `gh` 认证，并核当前登录账号与请求操作者一致；输出仅含非敏感状态，不读取或输出 token。

演练队列按 `enqueuedAt`、请求 ID 排序，容量包含在途项。样例容量为 20，单项等待预算为 45 分钟，属于待批准的演练参数。超额、重复及取消请求留下结束回执，不静默覆盖。恢复时将输出的 `state` 作为下一次输入；`finished` 必须保留，避免同一请求 ID 重放。普通失败后重提需要新的 ID 和对应许可。

真实 Actions 的等待顺序、容量与持久恢复仍由 07 决定；本地排序不保证平台按用户提交时间严格 FIFO，也没有自动保存队列或定时唤醒。

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

GitHub 读取仅使用固定 GET 端点。检查列表读取完整分页；API 错误不输出任意响应正文。当前门禁读取 classic protection，不能凭该决策宣布未来 ruleset、App bypass、请求审批或可信工作流配置已验收。

父提交检查能排除额外作者提交和错误 base，但不能独立证明更新由专用 App 发起。因此当前演练还要求对应 `policy.approvals` 项明确批准 `updatedHead`，否则返回 `update_source_unverified`，不会凭相同父提交接受作者替换。等待检查时也重核该许可。07 需决定保留新 head 重新批准，或实现经实际 App 验证的更新来源证明，验证同父提交的作者替换、并行 push 及 main 前进，保持未知结果暂停。质量保护必须由服务端继续执行，因为 merge API 不提供 expected base SHA。[GitHub PR API](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch) 的 202 只表示更新请求已受理；[commit API](https://docs.github.com/en/rest/commits/commits#get-a-commit) 的签名结果也应与目标 App 的实际更新方式核对。

07 启用前需具备专用 App/installation、最小权限与 main 限定 environment secret、独立唯一写入者 ruleset，以及不能被该 App 绕过的质量保护。入队授权、取消、预算、token 刷新、暂停接收与独立演练 PR 需另行批准和验收；本入口不启用它们。
