# 当前 source Host 窗口准入

这里覆盖现有官方 Core 的 Host/client 源码路径及其 sandbox 委托：

| mode                 | 公开入口                                                          | 冻结组合                                                |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| source-host          | `scripts/start.mjs`、`runSourceProfile(..., true, ...)`           | 当前完整 selection，或冻结五源及其已准备 snapshot       |
| isolated-source-host | `scripts/start-isolated-validation.mjs --plugins --sources ...`   | 冻结五源及其已准备 snapshot，启动后使用新的隔离 runtime |
| isolated-core-host   | 上述隔离 CLI 不加 plugins，或 `runSourceProfile(..., false, ...)` | 固定官方 Core，不装载公司插件                           |

这不是另一个 Native 启动器，也不覆盖旧 `desktop:dev`。有效预检只说明已有声明与本次请求相符，不产生用户开窗、登录、模型或业务授权。

## 先离线准备，再声明启动

从当前项目导航选择固定三仓/官方 Core，沿同组 Workbench 的 `verify-candidate-input.mjs --input <candidate.json> --checkout <GEA>` 检查。输入必须 clean，锁、HEAD 与候选一致；不得借用其它任务的可写 node_modules/lib。工具链与 SDK 的准备沿 [本地开发](local-development.md)。

已有 [source-profile](../scripts/source-profile.mjs) 是唯一组合所有者。首次准备仍用它的公开 interface；prepare、check/build 和选择都是离线阶段，不启动 Host，也不能据此恢复历史业务窗口：

```sh
corepack pnpm run source:check --sources /absolute/fixed-five-sources.json
corepack pnpm run source:build --sources /absolute/fixed-five-sources.json
```

随后在新的自有 runtime，通过公开 `prepareSourcePlugins(core, runtime, deployment, {sources})` 创建完整 snapshot；需启动已选组合时，再通过 `selectSourceCombination(runtime, composition.id, core)` 在 Host 停止条件下选择它。可执行调用如下，路径须换成本任务冻结输入：

```sh
node --input-type=module <<'JS'
import {readFile} from 'node:fs/promises';
import {readDeployment} from './scripts/deployment.mjs';
import {prepareSourcePlugins, selectSourceCombination} from './scripts/source-profile.mjs';
const core = '/absolute/fixed-official-core';
const runtime = '/absolute/new-owned-runtime';
const sources = JSON.parse(await readFile('/absolute/fixed-five-sources.json', 'utf8'));
const deployment = await readDeployment('/absolute/deployment.json', {resolveCredentials: false, credentialEnv: {}});
const composition = await prepareSourcePlugins(core, runtime, deployment, {sources});
await selectSourceCombination(runtime, composition.id, core);
console.log(JSON.stringify({runtime, id: composition.id}));
JS
```

准备会生成不可变组合、资源/依赖/锁摘要和默认 seed，不覆盖用户已选模型或 Session。支持的新启动输入必须引用已准备 snapshot；每份五源记录都明确 commit、assets、files、dependencies，其中 assets 与 dependencies 分别指向该 snapshot 的包目录和其 node_modules。files 从 combination.json.files 中提取该包前缀、去掉前缀与 node_modules 依赖条目；完整依赖图仍由 snapshot 原摘要核验。通过原 `readSourceCombination` 和 `resolveSourceInputs` 复核，不在启动中重建损坏或未冻结资产。隔离 source 模式不接受旧 runtime selection 代替五源声明。

## 窗口与冻结材料

当前窗口 JSON 保留已有 case、owner、状态、显式暂停及预算声明，另引用本窗口的冻结文件：

```json
{
  "case": "existing-authorized-case",
  "owner": "existing-owner",
  "status": "open",
  "paused": false,
  "freeze": { "file": "/absolute/new-frozen-window.json" },
  "budget": {
    "limits": {
      "hostStarts": 1,
      "businessRequests": 0,
      "modelTasks": 0,
      "businessWrites": 0
    },
    "remaining": {
      "hostStarts": 1,
      "businessRequests": 0,
      "modelTasks": 0,
      "businessWrites": 0
    }
  }
}
```

数值只是本地无价值 fixture 示例，不能作为实际预算。limits/remaining 必须来自既有有效声明和回执，可保留其它已声明额度键；四个列出的领域都须明确，limits 与 remaining 必须逐键对应，不能漏掉自动加载等其它已声明额度。缺证保持 unknown，不能填零。准入不扣减、重置、推导或回写计数；物理 SQL、销售自动请求、分页、失败和取消仍归 GEA 原执行合同。

冻结 JSON 的 `file` 须等于其实际文件名，case/owner/mode 必须与请求相同；记录绝对 core/runtime，candidate 的绝对 file 与原字节 SHA-256，窗口 budget 原值，以及下面的组合事实：

- selection：`{"kind":"selection","id":"<existing UUID>","manifestSha256":"<actual combination.json SHA-256>"}`。当前 selection 和完整 snapshot 均须匹配，三仓源码归属/提交须对应候选。
- 新五源：`{"kind":"sources","file":"/absolute/frozen-five-sources.json","sha256":"<raw file SHA-256>","snapshot":{"runtime":"/absolute/prepared-runtime","id":"<existing UUID>","manifestSha256":"<actual SHA-256>"}}`。传入的 sources 必须是该原件，当前启动 runtime 不能已有另一 selection。
- core-only：`{"kind":"core"}`，不接受公司 sources 或部署配置。

source-host 还记录 `config: {file, sha256}` 和 `deploymentSha256`。前者覆盖原 JSON 字节；后者是公开 `readDeployment(file, {resolveCredentials:false, credentialEnv:{}})` 返回值经 `JSON.stringify` 的 SHA-256。同一配置及其 SQL/销售额度由原 deployment 校验；纯预检不读 keychain 或写 credentialEnv，正式凭据读取仍在准入通过后沿默认行为执行。

对于 source-host，runtime 绑定实际目录；隔离模式绑定 CLI 的 `.runtime/plugin-split-validation` 父根及其 `run-*` 子目录。路径按真实父目录解析，别名不能改变冻结目标。冻结材料形成后，从它的原字节读取 SHA-256 传给本次请求。冻结不创建新的授权或预算，旧已关闭/暂停窗口不可重新打开。

## 启动与拒绝

```sh
corepack pnpm start --window /absolute/open-window.json --case existing-authorized-case --owner existing-owner --freeze-sha256 <actual-frozen-sha256> --config /absolute/deployment.json --runtime /absolute/owned-runtime --port 0
node scripts/start-isolated-validation.mjs --window /absolute/open-window.json --case existing-authorized-case --owner existing-owner --freeze-sha256 <actual-frozen-sha256> --plugins --sources /absolute/frozen-five-sources.json
```

直接调用 `runSourceProfile` 时，在最后的 options 提供 `window: {file, case, owner, freezeSha256}`，隔离 source 委托也提供 `mode: "isolated-source-host"`。默认 core-only/source-host 由 plugins 参数决定，参数与 mode 不匹配拒绝；省略窗口不成为绕过。`--help` 只显示说明。

普通 CLI 与测试包装共用 `runSourceProfile` 启动事务。无副作用的窗口检查通过后，入口取得已有 `source-profile.lock`，重新核对窗口、冻结输入与当前选择，在锁内完整验证选中组合一次，并直接消费该次验证的组合及组件元数据。完整性或凭据拒绝仍不创建 Profile、不启动 Host；验证期间只允许临时持有锁，失败时释放。复制、更新和下一次启动仍各自验证当前内容，不跨事务复用。

缺声明、关闭、暂停、错误 case/owner/mode/runtime/Core、预算 unknown/缺失/不一致/耗尽，以及配置、候选、组合或资源摘要错误都在本入口的 profile/config/env、keychain、启动进程和网络动作之前拒绝。预检中的共享候选 CLI/Git 仅做本地只读输入检查。错误不改来源、恢复旧协议或自动重试；真实关闭、预算和停止条件仍由原有效窗口负责。

`test:window` 通过同一 CLI/公开函数观察文件、环境、keychain、启动进程与网络 seam。正确声明只进入 loopback fixture，真实固定 Core 的 CLI/lib 不替换，Host/Native 不实际启动。这个结果不是模型、业务、安装或真实窗口验收。
