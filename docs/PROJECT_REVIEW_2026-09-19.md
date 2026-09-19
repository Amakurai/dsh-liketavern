# 项目审查与同类项目对照（2026-09-19）

本次针对 Windows / Node 24 / dsh 0.1.5-rc.2，检查存储回滚、异步界面、角色导入与查找、记忆检索和备份恢复。自动化回归均使用临时目录中的手写数据；另经用户授权，使用本机默认模型在独立 DSH_HOME 做真实宿主验收，没有读取用户剧情。本记录区分已交付改进与产品后续方向，不代表对所有第三方卡片的兼容承诺。

## 已修复的缺陷

| 优先级 | 可复现场景与影响 | 修复与回归 |
| --- | --- | --- |
| P1 | 较早楼层删除文件，较晚楼层重建同一路径。只撤销删除楼层原先会被允许；随后撤销重建楼层可能丢失最初原文。 | `src/state/wal.ts` 将删除后的“不存在”状态也纳入后继依赖，要求逆序回滚。`test/walDependencyAndPaths.test.ts` 验证拒绝乱序且完整回滚恢复原文。 |
| P1 | 回滚替换正文后故障，恢复游标仍在；此时重新开层或追加记录会改变日志哈希，使继续恢复失败。 | 回滚恢复期间拒绝 reopen、record、recordAfter、recordChange 与 commit，继续回滚不受阻。`test/transactionRecovery.test.ts` 注入真实文件写入故障，验证所有写入口拒绝且能恢复原文。 |
| P2 | 同一 assistant 组件由会话 A 切到 B，新绑定尚未返回时，加载器首帧仍暴露 A 的 ready 数据，消费方将其缓存为 B 的角色绑定。 | `useLoader` 按依赖、重试次数与启用状态隔离请求身份，首帧隐藏旧值；保留同会话刷新和超时后恢复。真实绑定文件配延迟 remote，以及提交阶段消费测试覆盖切换、禁用、重试和迟到回执。 |

以上三项均先通过新增用例确认原实现失败，再修改实现。

后续真实 UI 检查还发现角色描述、性格、场景等多行输入框缺少可访问名称，现已统一使用宿主表单标签，并验证双编辑器的标签身份独立。备份交叉审查发现 POSIX 只读目录导致失败草稿清理受阻，已修复并加入专属回归；本机 Windows 不执行该 POSIX 用例，CI 的 Ubuntu 任务会执行。

## 本次落地的体验改进

角色管理页、收纳箱和新会话选择器统一支持角色名、标签、作者、内嵌书名的字面包含搜索，忽略大小写和首尾空白。作者与标签来自已有角色资产，无额外详情请求，不读取剧情正文；旧列表没有这些字段时仍可正常按名称和书名搜索。

`test/characterSearch.test.tsx` 验证真实活动/收纳列表返回检索字段、旧磁盘卡缺失或异常元数据的归一化、两种界面的中文标签和英文作者搜索、带正则符号的普通文本、无结果与清空恢复。此功能借鉴 [SillyTavern 的标签组织与过滤](https://docs.sillytavern.app/usage/core-concepts/tags/)；目前仍是搜索框检索，多标签组合过滤、收藏和批量整理尚未实现。

## 同类项目对照与交付状态

项目已有实际宿主请求捕获、世界书触发日志、预算展示、角色标签编辑、草稿恢复、独立剧情分支和摘要来源保留。最初列出的前三项差距现已落地。

| 优先级 | 建议 | 本项目现状与验收方向 | 对照依据 |
| --- | --- | --- | --- |
| P1 | 导入前兼容报告：已完成 | `CharacterInspect` 返回有界静态报告，分支持、不支持、需运行时确认；检查已知接口、EJS、正则、脚本库/MVU、父窗口访问和外部资源。所有卡先预览，取消不写盘，失败可重试，内嵌书保留选择。单串 256 Ki 字符、总 2 Mi 字符、16384 节点、深度 24；触达上限明确报告未覆盖。 | [SillyTavern 扩展依赖与最低版本声明](https://docs.sillytavern.app/for-contributors/writing-extensions/#dependencies)提供能力前置检查的设计参考；它并非任意角色卡的完整静态检查器。 |
| P2 | 可校验的备份与恢复预检：已完成 | `dsh-tavern-backup` 提供 create / verify / restore；清单包含执行工具版本、大小和 SHA-256，检查 Tavern 结构/WAL/绑定引用，在新目录原子发布。明确离线声明、精确排除可重装依赖目录，保留宿主历史和 profile 配置；实际会话已用于恢复重启演练。 | [RisuAI 本地备份实现](https://github.com/kwaroran/RisuAI/blob/main/src/ts/drive/backuplocal.ts)覆盖数据库、资产与冷存储并报告缺失项；[ST JSONL 导出](https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/#export-as-jsonl)也明确不含图片和附件。 |
| P2 | 改善记忆候选覆盖率：已完成 | 自动入模先取最多 4 倍候选（上限 200），再按正文去重、预算与最终 topK 选择。同一完整叶来源集合的重复摘要延后补位，归档原文仍可补细节；关闭检索不读索引。新增 14 项中文剧情管线评测，覆盖重复/超长候选、别名、否定、更新、冻结、分支回退、多代来源与循环拒绝。 | [ST Data Bank](https://docs.sillytavern.app/usage/core-concepts/data-bank/)区分全局、角色和聊天检索范围；[RisuAI HypaV3](https://github.com/kwaroran/RisuAI/blob/main/src/ts/process/memory/hypav3.ts)分别为近期摘要与相似摘要分配预算。是否加入向量检索应由评测决定。 |
| P3 | 多标签过滤、收藏与稳定排序 | 本次已补作者和标签搜索。后续可提供可见的组合筛选及用户偏好保存；目前选择器最近使用只在当前运行期间保留。 | [ST 标签文档](https://docs.sillytavern.app/usage/core-concepts/tags/)展示多标签过滤、批量标记和标签目录。 |

这些方向适配插件定位。模型连接和完整聊天界面继续由宿主提供；第三方脚本仍使用现有沙箱与枚举业务桥。

## 验证与限制

`npm ci`、`npm run build`、`npm test`、`npm run doctor:check`、`npm run backup:check`、`npm pack --dry-run` 与 `npm run package:check` 均通过。全量 **136 个测试文件、1893 项测试通过，1 项 POSIX 专属用例在 Windows 跳过**，发布白名单 **417 个文件**。`lib/` 与源码一起重建；测试使用 Node 24.18.0。发布清单增加 backup 命令及导入入口，Ubuntu / Windows CI 同步加入备份 CLI 冒烟；本次未触发远端 CI。

后续按用户要求处理了剩余依赖告警：移除没有已发布补丁的 Showdown，改用固定版 markdown-it / markdown-it-emoji，当前 `npm audit` 为 0 项已知漏洞。保留 QuickJS/worker 与 iframe 边界，并明确格式差异和旧活动模板重放的升级限制；见 [依赖安全记录](DEPENDENCY_SECURITY.md)。上方测试计数是前一轮项目完善验收，依赖替换的最终计数另记于更新日志。

真实 Windows / rc.2 宿主已验证角色创建和保存、标签/作者搜索、带标签的多行编辑框、无内嵌书卡的兼容报告、取消后不新增角色及重新上传后保存。默认 `deepseek-official / deepseek-flash`（页面显示 DeepSeek-V41-Flash / High）正确回答角色口令，并通过原生 PTC 写入一条剧情记忆；实际记忆文件与对应楼层 `committed=true` 均已核对。凭据使用已有本机配置，不复制到项目；对话与备份均为临时测试数据。

实际停机备份/校验/恢复包含 32 文件、42 目录、233731 字节，明确排除 3 处可重装依赖目录，检查均无异常。恢复到新目录并启动宿主后，角色绑定、开场白和两轮对话可读；继续发送新请求，模型正常回答「蓝色工具箱。」并回到空闲。详见 [宿主兼容记录](HOST_COMPATIBILITY.md)。

备份校验覆盖字节清单和插件数据关系，不解析宿主压缩日志的完整语义；应保留恢复后的实际启动检查。版本记录来自备份工具运行环境，源安装以 profile 配置和锁文件核对。记忆仍是词面 BM25，别名需写入正文或 keys，不自动消解矛盾/指代；有界候选和预算可能导致最终条数少于配置。半衰期仍依据 updated，摘要生成时间不等同事实发生时间。
