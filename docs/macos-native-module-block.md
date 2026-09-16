# macOS 原生模块反复弹窗（2026-09-15）

## 确认的原因

正式客户端与 V1.6 本地预览中的 `system.node` 都携带 `com.apple.quarantine`，且只有 ad-hoc 签名。整包 `spctl --assess` 返回 rejected。预览复制保留扩展属性，所以同样触发拦截。启动页健康检查没有实际加载该原生模块，不能证明原生功能可用。

两个副本 SHA-256 均为 `ece3742d803863a851d9ad6babcf600712457c37184e3ddb8671f4ca71765171`。官方 npm `@deepseek-ai/node-addon-system-darwin-arm64@0.1.2` 下载归档的 SHA-512 integrity 通过；逐个 Mach-O section 比较与安装副本完全一致。重新签名后的文件布局不同，整文件摘要不同。

## 本机处理及验证

仅删除这两个经过核对的 `system.node` 的隔离属性，未改变二进制字节或全局 Gatekeeper 设置。原属性备份在 `.runtime/v16-feedback/system-node-local-repair.json`。使用客户端随包 Node 分别实际 require 两个文件，均成功导出 `tryLock`。

这是本机恢复措施，不代表安装包已通过 Apple 公证。其他原生库也携带隔离属性，本次没有批量放行；新下载的旧安装包仍可能复现。

## 正式分发完成条件

1. 使用 Apple Developer ID Application 证书签名所有嵌套 Mach-O、原生模块、Node 与 Electron，再签名外层应用；检查 hardened runtime、时间戳与所需 entitlements。
2. 提交 Apple notarytool，确认 Accepted，给应用及分发容器附加公证票据。
3. 在下载所得安装包及实际更新后的插件图上验证；不能只验证构建机本地目录。
4. 执行下面的只读检查，退出码为 0 才允许认定应用可分发：

```sh
python3 desktop/verify-macos-distribution.py '/path/to/GEA Desktop.app'
```

该脚本检查签名、原生模块 Developer ID、公证票据及 Gatekeeper，不自动移除隔离属性。它是独立验收入口，尚未接入公司发行流水线；不能替代真实下载、安装、更新验收。

本机钥匙串只有 `GEAUi Local Code Signing` 自建证书，没有 Developer ID Application，因此正式签名、公证与重新发行尚未完成。

参考：[Apple 的签名与公证要求](https://developer.apple.com/developer-id/)。
