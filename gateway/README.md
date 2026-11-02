# 个人记忆 HTTP 网关

合同见 [protocol](../docs/memory/protocol.md)。网关使用 Python 标准库与 SQLite，无 pip 依赖。运行需要 Python 3.9+；旧服务器系统 Python 3.6 不可直接运行，部署票负责固定容器版本与资源限制。

服务器运行于 POSIX 环境，同一 SQLite 只启动一个 ThreadingHTTPServer。启动时持有元数据旁的内核独占锁，新进程获得所有权后恢复前任中断的任务；进程死亡和容器 PID 复用不会使旧 processing 永久存活。锁文件需与 SQLite 同目录持久保留，不能在运行中移除或让不同容器使用不同的锁路径访问同一 SQLite。

必需环境变量为 `GEA_ENVIRONMENTS`，值为固定 production/test HTTPS 地址对象；`MEMORY_METADATA_PATH`，值为持久 SQLite 文件路径；`HINDSIGHT_URL`；`HINDSIGHT_API_KEY`。密钥仅从部署环境读取，不写入配置样例或客户端。默认 `MEMORY_BIND=127.0.0.1`、`MEMORY_PORT=1934`，容器部署按明确入口配置绑定地址。执行 `python3 personal_memory.py` 启动。身份与 Hindsight 不跟随 HTTP 重定向。

在 gateway 目录执行 `python3 -m unittest discover -s tests -v`；现有 Node CI 通过 `tests/memory-gateway.test.mjs` 执行同一公开 HTTP 套件，gateway 变更由 GEA 的影响策略选入。测试启动实际本地 HTTP 服务，数据为合成夹具，不连接生产。SQLite 只持久化归属、开关、版本、来源与操作回执；Hindsight 保存正文。单次列表最多500个登记条目、返回条目 JSON 总计220000字节；超过返回 MEMORY_LIST_LIMIT，不静默截断。读取正文有总时限，返回前重新核版本，不在 DB 全局锁内等待网络。

部署与删除验收需先满足 protocol 中的原始 LLM trace 前提。单删、清空和关闭生成出现 unknown 时，持久任务仍需核查；HTTP 200 仅表示网关成功返回回执，只有 status=completed 才表示该操作承诺的清理完成。
