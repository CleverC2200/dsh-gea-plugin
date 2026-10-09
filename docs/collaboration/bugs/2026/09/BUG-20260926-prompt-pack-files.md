<!-- collaboration-record
{"kind":"bug","id":"BUG-20260926-prompt-pack-files","date":"2026-09-26","title":"新增托管Prompt与Skill未显式进入打包白名单","module":"业务Agent与打包","category":"构建发布","cause":"原始遗漏","severity":"P1","status":"已发布待验收"}
-->
# 新增托管Prompt与Skill未显式进入打包白名单

新增presets/prompt-policy.json与inventory-apsplan/fc/qll.skill.md由npm目录规则发现，但严格打包白名单没有对应条目。已在package.json.files显式登记4个文件，依赖不变。dry-run确认37个文件；待合并后完成实际包空目录安装和运行验证。

候选版本0.0.127。原打包白名单仍严格校验，未放宽为任意文件可打包；没有删除旧入口或文件。发布状态以本次发行记录读回为准。

发布后验证：0.0.127打包及空目录安装/运行通过，4个新增文件均在37文件的严格白名单内。MR !184及对应源码标签已固定；用户当前桌面未自动切换。
