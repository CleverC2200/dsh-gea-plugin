# 当前官方客户端与源码组合验证

本轮固定输入：官方 `dsh-v0.2.1-alpha.1` / `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，通过标准官方构建提供 SDK/客户端产物。Core源码和产物不做本地补修；官方客户端使用其标准 `pnpm dev:desktop` / `pnpm start:desktop`。Web/离线测试只提供开发反馈，不替代最终正式UI同源与实际客户端验收。

源码组合只有既有 Workbench、Manage、GEA、GenUI、Better Sidebar；它们由自己的官方bundle/profile入口装配，GEA patch只登记业务接入本身。官方插件生命周期与Manage Suite/Skill/MCP资源状态分开。原资源窄source贡献、业务算法/权限/取消保持，官方standard preset不重写。

`source-profile.mjs`是唯一assembler：固定sources可声明source、commit、integration，以及需复用的assets/files和dependencies。新prepare/check/build必须明确提供同一五源records；缺来源在SDK扫描/写入前拒绝，不存在workspace/sibling默认。源包name须匹配登记owner，source和integration必须clean且一致；只复制发布资产、不复制依赖或SDK。corePackages供同一type/check/build/组合链解析官方包。声明assets/files时统一校验全部发布文件与必要host/client/patch入口，不tsc/build冻结资产；损坏拒绝且不重建。普通source按原工具链执行；已选历史完整组合读回不要求新records。每次组合记录原件及实际依赖hash，选择在独占锁内通过CAS、原子写入、读回验证；unknown不自动重写/回滚。

```sh
corepack pnpm run source:check --sources /absolute/fixed-sources.json
corepack pnpm run source:build --sources /absolute/fixed-sources.json
corepack pnpm start --config /absolute/deployment.json --sources /absolute/fixed-sources.json --runtime /absolute/owned-runtime --port 0
```

不得让源准备过程改user profile。模型默认seed写入新snapshot，真正launcher在自己的profile以flagwx采用；已存在用户选择保持。正常真实客户端/组合切换由root串行执行。workflow Host定向fixture仅临时home/profile、loopback服务和port0，不能接真实GEA、模型或生产端点；记录它自己的PID并清理，不触root/旧运行。

旧Hub/example、source-presets及旧reader的装配路径不在当前组合。历史公司桌面壳源码及仍被其使用的preset helper/测试不属此次官方客户端目标；保持原件，不重做其兼容，不把当前源码门禁说成旧壳发布/验收。

current source-profile直接调用businessDeploymentPatch，仅给GEA真实业务/模型配置；旧公司desktop仍调用deploymentPatch中的历史UI/preset装配，业务声明共享现有module同一规则，不把旧helper带进最新source启动。
