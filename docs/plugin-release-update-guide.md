# DSH 插件更新与发版流程

这份说明适用于 DSH GEA HTML 插件。插件源码仓库和发行库是两个不同环节：源码仓库负责开发和生成固定包，`dsh-plugin-releases` 负责登记包、更新测试/正式频道，客户端最终从频道读取可用版本。

## 一、先分清三个东西

| 内容 | 所在位置 | 作用 |
|---|---|---|
| 插件源码 | 各自的插件仓库，例如 `dsh-agent-aps-delivery-plugin` | 页面、Skill、`plugin.json` 和构建输入 |
| 固定插件包 | 发行库 `packages/` 或约定的包目录 | 可下载、可校验的 zip 文件 |
| 更新频道 | 发行库 `channels/*.json` | 告诉 GEA/客户端当前应该下载哪个版本 |

只改源码仓库，客户端不会自动拿到新版本；只改频道但发行库没有对应固定包，也不能完成更新。

## 二、源码仓库的正确更新方式

### 1. 从最新 `main` 建发布分支

不要直接在 `main` 上改。先刷新远端并记录基线：

```bash
git fetch origin main
git rev-parse origin/main
git switch -c codex/release-<plugin>-<version> origin/main
```

例如：

```bash
git switch -c codex/release-aps-delivery-0.1.0-preview.9 origin/main
```

### 2. 修改源码和版本信息

至少检查这些内容是否一致：

- `plugin.json` 的 `version`；
- `PROVENANCE.json` 中的包名、版本、文件摘要；
- `VALIDATION.json` 中的验证状态、包文件名、SHA-256 和字节数；
- `index.html`、Skill、MCP 配置和其他实际发布文件；
- 包内文件清单不能混入本地构建缓存、`.runtime`、`node_modules` 等目录。

版本变了就必须生成新包。已经发布过的 `包名@版本` 不要覆盖。

### 3. 本地生成并检查固定包

这个插件仓库的打包脚本在 `scripts/package.py`，不是仓库根目录。使用项目约定的脚本，例如：

```bash
python3 scripts/package.py
```

然后检查：

- zip 文件名和 `plugin.json` 版本一致；
- 包内文件清单正确；
- SHA-256 和文件大小与 `VALIDATION.json` 一致；
- 包中没有源码仓库之外的临时文件；
- HTML 页面能在目标宿主中加载；
- Skill 和 MCP 配置路径正确。

如果项目提供 `release:preflight`，优先执行它。没有的话，至少完成包清单、来源摘要、归档路径和关键页面检查。

### 4. 提交、推送并创建 MR

```bash
git add <源码和发布清单>
git commit -m "release: <plugin> <version>"
git push -u origin codex/release-<plugin>-<version>
```

然后创建 GitLab MR，目标分支是 `main`。MR 必须实际合并，并记录：

- MR IID 和 URL；
- 源分支、目标分支；
- `merge_commit_sha`；
- 合并后的远端 `main` SHA。

不要用“已经推送分支”代替 MR，也不要在 MR 合并前把包上传到发行库或推进频道。

## 三、发行库的正确更新方式

你的 GEA 0.0.62 采用的是下面这种两阶段方式，这也是推荐方式。

### 1. 从合并后的源码固定包

MR 合并后重新拉取远端 `main`，从合并提交对应的干净源码生成包。记录这个源码 SHA，后面包、标签、频道都绑定它。

### 2. 先登记固定包

在 `dsh-plugin-releases` 中新增包文件和对应校验信息，提交信息可以采用：

```text
release: add <plugin> <version> artifact
```

这一提交只负责让发行库拥有固定包和它的 SHA-256，不直接改变测试/正式频道。

### 3. 再提升频道

确认包上传、下载和校验通过后，再更新目标频道 JSON，提交信息可以采用：

```text
release: promote <plugin> <version> channels
```

频道变更必须保留其他插件已有条目，只修改本次插件的条目。测试频道和正式频道要分别确认，不能把测试版本误写成正式版本。

### 4. 通过 MR 合并发行库改动

发行库也走发布分支和 MR：

```text
codex/release-<plugin>-<version>
```

典型提交顺序是：

1. `release: add ... artifact`
2. `release: promote ... channels`
3. 创建 MR
4. MR 合并回发行库 `main`

你这次 GEA 0.0.62 的记录就是：

- `1f1f91f6`：添加 0.0.62 包；
- `16bd2566`：提升 0.0.62 频道；
- `4a2f85ce`：合并 `codex/release-gea-0.0.62` 到 `main`。

## 四、频道更新后的验证

发行库合并后，重新读回远端频道并校验包：

```bash
python3 skills/dsh-plugin-release/scripts/check_channel.py \
  /absolute/path/to/dsh-plugin-releases/channels/<channel>.json \
  --repo /absolute/path/to/dsh-plugin-releases \
  --online-changed
```

至少确认：

- 频道中的版本、下载地址、SHA-256 和包文件一致；
- 下载地址实际可访问；
- 未参与本次发布的插件条目没有被覆盖；
- 测试频道和正式频道的兼容版本填写正确；
- 固定包对应的是已经合并到源码 `main` 的提交。

如果需要真实安装验收，应先在测试频道验证安装、启动、页面加载和数据保留，再把同一个固定包提升到正式频道。正式频道提升不能重新打包。

## 五、当前这些插件遇到的问题

截图中的橙色状态不是构建失败，而是 GitLab CI 的 `pending/stuck`。已核对的 Job #523 页面提示：

```text
This job is stuck because you don't have any active runners that can run this job.
```

处理方法：

1. 打开项目 `Settings → CI/CD → Runners`；
2. 确认项目、群组或实例 Runner 处于 active 状态；
3. 检查 Runner 标签是否匹配 `.gitlab-ci.yml`；
4. 检查 Runner 是否允许执行受保护的 `main` 分支；
5. Runner 恢复后重试 pipeline。

如果这些插件不需要 Auto DevOps，应改成团队统一的插件检查/打包流水线，而不是让默认 Auto DevOps 一直等待不存在的 Runner。

Runner 修好只代表 CI 可以运行，不代表公司插件已经发版。正式发版还必须完成源码 MR、固定包、发行库提交、频道更新和安装验收。

## 六、发布完成的判断标准

下面这些条件全部满足，才能说“插件已发版”：

- 源码 MR 已合并到 `main`；
- 包从合并后的固定源码生成；
- 包版本没有覆盖旧版本；
- 包 SHA-256、文件清单和下载地址已记录；
- 发行库 MR 已合并；
- 目标频道已更新并远端读回验证；
- 测试安装或适用的运行验收已完成；
- 能提供源码 SHA、包版本、包 SHA-256、频道和验证结果。

只看到 GitLab 项目最近更新、只有 pipeline pending，或者只看到源码仓库里新增了 `VALIDATION.json`，都不能算完成发版。
