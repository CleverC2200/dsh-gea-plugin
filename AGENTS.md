# AGENTS.md

## 开发依赖与构建

源码开发使用 `package.json` 固定的 pnpm，首次准备运行 `pnpm install --frozen-lockfile`；不要混用 npm 安装同一开发 node_modules。独立发行包继续保留 npm shrinkwrap 消费协议，桌面安装器沿用自己的固定工具链。

日常开发用 `pnpm dev` 增量构建插件，或按改动运行 `build:host`、`build:client`、`build:workbench`。`pnpm build` 保留包含示例插件的完整发行构建；打包前应确保所有文件与源码一致。示例不随普通业务开发反复构建。

依赖或锁变化需验证冻结安装、关键依赖/共享 Cordis 解析及最终 tarball 的 npm 空目录安装；构建许可和私有 Git override 只作用于本仓库，不推广成全局配置。

## 公司插件发行

涉及公司 DSH 插件发版、GitLab 发行库或桌面更新频道时，使用 `dsh-plugin-release` 技能。公司源码、发行资产和更新频道统一走 GitLab；普通开发继续遵循本仓库规则。

本仓库同时维护 GEA 插件和公司客户端；`desktop/` 是客户端源码、构建和安装包的唯一入口。其他 DSH 插件仓库只交付各自的插件或资源套件，需要客户端兼容改动时在这里单独处理。

普通 GEA 页面、文案、样式和插件业务逻辑改动默认只构建、验证和发布 GEA 插件；插件任务中的“发布”默认指插件发布。在桌面中验证插件不等于重打客户端。只有 Electron 壳、启动器、内置运行时、安装或桌面更新协议需要改变，或者用户明确要求发布客户端时，才按 `desktop/README.md` 构建客户端安装包。

GEA 新版本仅发布到 `dsh-0.1.6-test.json` 和 `dsh-0.1.6-stable.json`。旧的 `test.json`、`stable.json` 只保留其最后兼容版本，不再推进 GEA 新版本。
