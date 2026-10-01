# sqld 与 quicSQL 本地对比

测试日期：2026-10-02。目标是判断 quicSQL 能否在保留现有 libSQL 客户端的前提下，降低 nanollm 的数据库服务内存和存储开销。

## 对比结论

两轮完整测试（第二轮反转执行顺序）均通过协议兼容、全部数据与索引校验、事务原子性、重启持久性和保留 100 条的写入检查。对于本项目的单节点 HTTP 数据库用途，quicSQL 是值得继续验证的替代候选。

- 大记录读写结束时，quicSQL 进程 RSS 为 47–52 MiB，sqld 为 109–112 MiB；备份导入后分别为 40–46 MiB 和 63–65 MiB。最终校验并静置后，差距缩小为 43–44 MiB 对 49–65 MiB，不能概括成始终节省一半内存。
- 两轮保留测试中，quicSQL 数据目录都稳定在约 173.7 MiB，sqld 最终约 460–463 MiB。sqld 目录中的额外复制日志和快照是差别的重要来源，不能单纯归因于实现语言。
- quicSQL 最大记录读取更快，完整替换写入略慢；保留测试总耗时接近。
- 容器文件缓存随负载和系统回收变化，第一轮某个静置阶段 sqld 容器总量反而更低。进程 RSS 优势不能直接换算成 Railway 账单，也不能保证总费用低于每月 5 美元。

建议先验证 nanollm 的实际应用流程，再决定是否切换。当前仅完成本地对比，没有部署 quicSQL，也没有切换生产连接；nanollm 仍使用 Turso。

## 测试范围

使用现有 Turso 备份还原出的 SQLite 文件（151,183,360 字节），六张业务表共 2,203 行、六个显式索引。请求详情有 100 条，内容合计约 144 MiB，最大行约 4.04 MiB。全程在本地 Docker 中执行，没有连接或修改生产 Railway/Turso。

- sqld：生产正在使用的 `0.24.33`，镜像固定为 `ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67`。
- quicSQL：官方 `v0.6.0` Linux amd64 发布包，压缩包 SHA-256 为 `73b63b16fdf9a4d3d807e2f342a876c5801bfda0a15366f89818322638baaeae`，与官方发布的校验文件一致。官方容器拉取返回 unauthorized，因此用包内二进制和 `busybox:1.37` 制作本地镜像，服务进程直接运行二进制。
- 两者均限制为 1 CPU、512 MiB 内存、禁用额外 swap，独立临时 Docker Volume，无鉴权、HTTP/1.1、本地回环访问。
- 客户端均为仓库当前的 `@libsql/client 0.17.4`。没有主动 GC、清空系统缓存、定时重启或 SQLite 手动压缩；只有明确标注的持久性测试会重启。
- sqld 使用 standalone 默认配置；quicSQL 使用普通 file 后端和 recommended PRAGMA preset，没有额外缩小页缓存、调整连接池或设置 Go 内存限制。
- 第一轮顺序为 sqld、quicSQL；第二轮逆序，均使用新容器和新 Volume。单次测试包含下面全部负载，避免只比较空库。

## 负载与正确性检查

1. 空库启动和 `SELECT 1`。
2. 多语句执行、参数化批量写入、超过 2^53 的整数、BLOB、中文/emoji、REAL、事务提交/回滚，以及失败批次不能留下部分写入。
3. 使用仓库的迁移库从固定备份导入全部业务表和索引，校验结构、行数、完整内容 SHA-256。
4. 读取最大请求详情 20 次；并发度 4、每路读取 5 次；完整替换写入同一大记录 20 次，再检查内容仍与备份一致。
5. 静置 30 秒，记录内存；重启，再做完整数据校验。
6. 在额外测试表中写入 1,000 条每条 256 KiB 的 TEXT，每次事务同时删除旧行，仅保留 100 条。每写入 100 条检查行数并采样内存和磁盘。
7. 删除额外测试表，再校验原来的六张业务表，静置 30 秒采样，最后删除测试容器和 Volume。

保留测试是在真实备份之外新增一张表，避免覆盖原始详情；原来约 144 MiB 的业务数据始终保留。256 KiB 固定内容用于观察页复用与日志增长，不代表真实请求的大小分布。

内存数据来自 `/proc/1/status` 和 cgroup v2 的 `memory.current`、`memory.stat`；磁盘来自 `du -ak` 的已分配空间。进程 RSS 与容器总量不能相加。表中容器总量包含文件缓存，区别于 Docker stats 常见的扣缓存显示。

Linux 的共享文件页面可能记账到最初触碰它的其他 cgroup：第二轮空库 quicSQL 的进程 RSS 为 15.2 MiB，容器记账仅 5.8 MiB。这不表示测量错误，而是两种指标的记账范围不同，也说明空库/共享镜像缓存的数字不能直接预测独立云实例费用。

## 第一轮实测

单位均为 MiB，内存值是该阶段结束时的采样，不能当成阶段内绝对峰值。

| 阶段 | sqld RSS | quicSQL RSS | sqld 容器总量 | quicSQL 容器总量 |
| --- | ---: | ---: | ---: | ---: |
| 空库 | 22.1 | 15.2 | 49.6 | 26.6 |
| 完整备份导入与校验后 | 65.3 | 46.4 | 400.2 | 213.7 |
| 大记录读写后 | 112.2 | 47.2 | 511.8 | 215.6 |
| 大记录负载后静置 30 秒 | 93.9 | 32.6 | 100.4 | 200.8 |
| 保留测试写入 1,000 条时 | 52.2 | 28.1 | 374.4 | 49.0 |
| 最终校验后静置 30 秒 | 64.7 | 44.1 | 386.0 | 65.5 |

文件缓存的差别尤其明显：大记录负载结束时 sqld 约 403.2 MiB、quicSQL 约 172.4 MiB；最终静置时分别约 329.4 MiB 和 29.5 MiB。但缓存会被系统回收，第一轮 sqld 静置时容器总量也曾降到 100.4 MiB，低于同一阶段的 quicSQL。因此不能承诺容器总量在所有时刻都更低，也不能直接换算为 Railway 月账单。

| 操作 | sqld 耗时（秒） | quicSQL 耗时（秒） |
| --- | ---: | ---: |
| 导入备份并完整校验 | 65.5 | 48.3 |
| 最大记录顺序读取 20 次 | 8.1 | 1.9 |
| 最大记录并发 4 × 5 次读取 | 3.9 | 1.2 |
| 最大记录完整替换 20 次 | 2.6 | 3.2 |
| 1,000 次事务写入与保留删除 | 37.4 | 35.1 |

耗时包含 Windows/Docker 本地网络、客户端编码解码等开销，适用于本机同条件比较，不能当成 Railway 的绝对性能预测。
保留测试耗时还包含每 100 次写入后的行数检查、容器资源采样和报告落盘，不是纯 SQL 吞吐量。

保留测试中，quicSQL 数据目录从写入 100 条时的 172.4 MiB 增至 1,000 条时的 173.7 MiB，业务数据加上约 25 MiB 的额外活跃数据后基本稳定。sqld 对应为 380.5 MiB 和 459.8 MiB，中间会随复制日志、快照和压缩变化。删除额外表后，最终目录分别约 173.7 MiB 和 459.9 MiB。普通 SQLite 删除行后不必缩小主文件，后续写入复用空闲页。

## 第二轮实测（quicSQL → sqld）

使用全新的容器和 Volume，单位仍为 MiB，内存仍为阶段结束采样。

| 阶段 | sqld RSS | quicSQL RSS | sqld 容器总量 | quicSQL 容器总量 |
| --- | ---: | ---: | ---: | ---: |
| 空库 | 21.7 | 15.2 | 8.6 | 5.8 |
| 完整备份导入与校验后 | 63.0 | 39.8 | 356.3 | 186.3 |
| 大记录读写后 | 108.7 | 51.6 | 511.8 | 199.5 |
| 大记录负载后静置 30 秒 | 92.3 | 41.3 | 415.2 | 188.7 |
| 保留测试写入 1,000 条时 | 52.2 | 27.2 | 217.9 | 47.7 |
| 最终校验后静置 30 秒 | 48.6 | 42.6 | 214.7 | 63.4 |

第二轮大记录负载后的文件缓存分别为 sqld 404.7 MiB、quicSQL 152.1 MiB，最终为 173.5 MiB 和 29.5 MiB。quicSQL 保留测试的目录从 100 条时的 172.4 MiB 增至 1,000 条时的 173.7 MiB，最终仍为 173.7 MiB；sqld 写入 1,000 条时为 462.7 MiB，最终为 462.8 MiB。两轮中未观察到 quicSQL 随累计写入次数持续扩张，但这不是长期增长上限的证明。

| 操作 | sqld 耗时（秒） | quicSQL 耗时（秒） |
| --- | ---: | ---: |
| 导入备份并完整校验 | 61.5 | 52.2 |
| 最大记录顺序读取 20 次 | 7.1 | 2.2 |
| 最大记录并发 4 × 5 次读取 | 4.8 | 1.3 |
| 最大记录完整替换 20 次 | 2.6 | 3.4 |
| 1,000 次事务写入与保留删除 | 37.4 | 36.9 |

完整指标见 [第一轮 JSON](benchmarks/sqlite-http-run1.json) 和 [第二轮 JSON](benchmarks/sqlite-http-run2.json)，包含阶段采样、进程 RSS 高水位、容器峰值和目录分项。两轮完成后，原始备份的 SHA-256 未变化，测试容器和临时 Volume 已清理。

## 兼容性与上线边界

两轮两者均通过全部上述正确性检查、重启后完整校验及最终完整校验。quicSQL 可以使用现有 `@libsql/client`，URL 示例为 `http://host:7775/app/`；本次实测去掉末尾 `/` 会返回 SERVER_ERROR。不能只把原来的 sqld 根 URL 换一个端口而不加数据库路径。

第二轮两者探测到的 PRAGMA 相同：WAL、`cache_size=-2000`、`page_size=4096`、`foreign_keys=1`、`mmap_size=0`、`wal_autocheckpoint=1000`。仍需要真正运行 nanollm，验证其初始化、记录清理、图片引用和统计读写的集成行为；本次协议与数据库测试不等于所有应用流程都已经验证。quicSQL 本次使用版本为 v0.6.0，官方容器拉取失败也是后续部署需要解决的事项；这些测试没有覆盖长时间运行、故障恢复或版本升级。

## 重现与资料

基准脚本是 `scripts/compare-sqlite-http.mjs`。先执行 `npm run build`，准备上述 quicSQL 本地镜像和 YAML，然后在 PowerShell 中设置：

```powershell
$env:SQLITE_BENCH_SOURCE = 'C:\Users\sunwu\.codex\backups\nanollm-2026-10-02\turso-snapshot.db'
$env:SQLITE_BENCH_CONFIG = 'C:\Users\sunwu\.codex\tmp\sqlite-http-comparison\quicsql.yaml'
$env:SQLITE_BENCH_OUTPUT = 'C:\Users\sunwu\.codex\tmp\sqlite-http-comparison\results.json'
$env:SQLITE_BENCH_ORDER = 'sqld,quic' # 第二轮使用 quic,sqld
node scripts/compare-sqlite-http.mjs
```

quicSQL 配置只开启一个 HTTP listener，`server.data_dir=/data`，数据库名 app、file 后端、`path=app.db`、`mode=rwc`、`pragmas_preset=recommended`。本地镜像 Dockerfile 为 busybox 基础镜像、COPY 官方二进制、WORKDIR /data、ENTRYPOINT 直接执行 quicsql。

备份源 SHA-256：`7053626c539efabbdd154d85af768b4e11c1d677262a2ae747a1e8ab19fc6c5d`。仓库中的 JSON 报告只记录表名、计数、哈希、索引数量和资源指标，不包含完整 schema、记录正文或生产凭据。

- [quicSQL v0.6.0 官方发布](https://github.com/quicsql/quicsql/releases/tag/v0.6.0)
- [quicSQL JavaScript/libSQL 客户端文档](https://quicsql.com/docs/clients/javascript/)
- [quicSQL 数据库和连接池配置](https://quicsql.com/docs/databases/)
- [sqld 固定版本源码](https://github.com/tursodatabase/libsql/tree/d6c75af6353bb1c34985399608e37cd272a35aa1/libsql-server)
- [Linux cgroup v2 内存统计定义](https://docs.kernel.org/admin-guide/cgroup-v2.html)
