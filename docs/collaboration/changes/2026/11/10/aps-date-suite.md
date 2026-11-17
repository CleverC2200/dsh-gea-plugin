<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261110-aps-date-suite","date":"2026-11-10","title":"兼容产销协同默认日期修复组合","module":"插件发行","status":"已验证待发布"}
-->

# Workbench日期修复兼容组合

GEA准备版本0.0.261，保留既有精确兼容范围并增加Workbench0.1.87。配套Manage使用company.62；本轮不改变业务身份、数据权限、Core或桌面构建输入。Workbench默认最新日期和手动日期的具体行为及回归见其CHANGE-20261110-aps-default-date记录。

发布前核主线、不可变版本及固定三包预检。正式频道、GitHub Release、来源下载和业务验收分别留证。

配套 Manage 使用 0.6.3-company.62 的新归档；其业务源码沿用当前主线，隔离构建路径产生不同 CSS 模块标识时不替换原 0.6.3-company.60 字节。
