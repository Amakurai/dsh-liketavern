# 状态、提示词与故障边界

## 角色资产与剧情状态

角色卡是可复用设定。记忆、世界变化、笔记、聊天世界书和 WI 定时器是某条剧情的当前状态。两者不能共用一个可变工作区，否则重新生成会修改原会话，而兄弟分支会读到彼此的事实。

```text
$DSH_HOME/dsh-tavern/characters/<cardId>/
  card.json / card.png / assets/character-book.json / assets/regex-scripts.json
  memory/ / journal.md / state/ / assets/chat-lorebook.json  # 新会话初始状态
  stories/<storyId>/
    story.json                          # 所属 sessionId、创建时间、迁移标识
    memory/ / memory/archive/           # 活跃事实与来源原文
    journal.md / assets/chat-lorebook.json
    state/world-delta.jsonl / state/wi-timers/ / state/wal/
    index.json                          # 可重建索引
```

绑定的 storyId 由 host 管理，客户端不能通过 setSessionBinding 接管其它会话的状态。新会话复制初始状态，之后独立演进；面板的“初始状态”只影响未来新建的会话。记忆面板选择角色后再选择剧情，所有写请求显式携带该 storyId。角色卡、预设和全局/角色世界书仍是共享资产，编辑会影响使用它们的剧情的下一轮。

旧版无 storyId 的绑定首次加载时，复制当前角色工作区的可变数据到稳定的 legacy ID，保留原文件与来源 WAL。迁移幂等。旧版已经混合的事实、缺失的 WAL 或早先已经撤销的数据，不能可靠重建成各分支原本的状态；应在迁移后按会话核对，必要时手动修订。迁移不是历史修复算法。

## 分支与回滚

```mermaid
sequenceDiagram
  participant UI as 楼层操作
  participant S as 来源剧情
  participant D as 私有草稿
  participant H as 宿主子会话
  UI->>S: 锁住来源并复制可变文件与 WAL
  S->>D: 独立快照
  Note over S: 原会话状态不变
  D->>D: 整批校验 WAL，撤销未继承楼层
  D->>D: 复制边界定时器，重建索引
  D->>D: 原子发布剧情目录
  UI->>H: agents.create + seed + provider/model
  UI->>H: attachSession + 保存独立 storyId
```

重新生成/编辑用户输入撤销目标层及以后。回退到某层保留该层。编辑 assistant 保留修改后的正文，但撤销该层及以后由旧正文产生的事实和定时器；不调用模型猜测新事实，也不自动续跑。需要的新状态由下一轮工具或面板建立。

每次写入的 before/after 镜像先原子落 WAL，正文随后原子替换。beginFloor 只接受新楼层；已有楼层（含已提交或元数据缺失）拒绝覆盖，避免丢失原始回滚镜像。完成楼层的受控追加使用 reopenFloor 保留记录，重新生成须先回滚旧层。回滚先验证所有目标日志，不接受损坏 JSON、非法路径、序号或编码。旧共享 WAL 中若仍有同一文件的后继依赖，拒绝越过它撤销，防止撤销后继时复活已取消事实；世界变化层按 id 判断依赖。

回滚的 pending 操作和游标持久化到 rollback-progress.json。恢复时文件已是目标值则推进；仍是原值则完成替换；第三方又修改过则停止并报告冲突。每一步都可重试，不能把“部分成功”标记成完整回滚。分支回滚在草稿内进行，失败不会修改来源或公布半成品。

锁覆盖整个读改写和多文件快照，是进程内锁。同一数据目录不支持多个宿主进程并发写。文件化快照用空间换隔离，磁盘占用随剧情与归档增长；当前没有自动清理历史剧情，也没有跨进程事务。

## 记忆维护

辅助模型流必须正常 stop，并在 60 秒内完整返回；error、aborted、max-tokens、缺终止帧和空正文都不能归档。提交摘要前复核来源未变，先写摘要再归档原文。失败保留 pending，下一个已完成轮次的 idle 再尝试，同轮不会因维护自身的 idle 事件反复请求模型。

摘要可能遗漏事实，不能称为无损压缩。BM25 搜索同时索引活跃摘要可达的归档来源，结果含归档标识与可读取路径；模型可按条读取原文。只索引可达来源，不扫描所有旧归档；上限 10000 个可达条目，超过时明确报错。去重只查活跃条目，避免让模型更新已归档条目。检索输出仍受 topK 和 token 预算限制。

源楼层回滚时递归展开受影响摘要，再撤销原事实。手动修改的摘要按既有保留人工修订语义处理。归档保留原文，不保证自动摘要本身与原文语义等价。

## 提示词通道和诊断

| 数据 | 实际路径 |
| --- | --- |
| 角色定义、稳定预设、确定常驻 WI、静态深度注入 | system 段 tavern:standing，工具说明之后 |
| 本轮宏、触发 WI、记忆、世界变化、AN、笔记 | runtime context tavern:turn |
| 历史消息、图片、工具调用、工具结果 | 宿主 deriveMessages 与 agent-loop |
| ST 深度插入、历史正则、历史裁剪 | ST 模拟序列与辅助代答 |

live standing 在模拟预算裁剪前构造，历史增长不再导致角色定义被裁掉并钉死。只有确定常驻条目可进 standing：概率、组竞争、sticky/cooldown/delay、递归门槛或本轮宏都走 turn；probability=0 必须尊重。插件通道有独立体积检查，宿主历史/system/tools 的最终窗口与压缩由宿主负责，模拟 token 数不能代替实际请求计量。

每轮首次成功组装冻结完整计划与 standing 指纹，后续 step 每次重放同样的通道。设置、资产与时钟中途变化下一轮生效。失败不发布计划、不提交 WI 定时器，也不静默改成缺设定的请求。工具同轮写入通过 notice 确认，下一轮才重新检索。

当前 dsh 深度冻结 GenerateOptions；agent/request 只变更采样，llm/stream 的 next() 不接收替换消息。因此 live 不改写历史。新正则默认 output/render；input/send、prompt/assemble、prompt/send 明示为模拟与代答用途，不假装已经影响普通会话的入模消息。

“最近宿主请求”通过 llm/stream 只读捕获适配器转换前的请求，包含实际 system/messages/tools 和采样。内存只保留八个会话各一份，单份最多 2 MiB 字符，截断明示；不落盘，重启/淘汰后不可用。它不是供应商最终 HTTP 包，适配器之后的转换仍需看供应商日志。其他预览页签是重新计算的 ST 模拟。

## 第三方计算与类型检查

EJS 提示词模板在同一 worker 内另建 QuickJS/WASM 实例，只有复制的 JSON 输入与有界 JSON 输出，无 Node/DOM/网络桥。模板状态与已处理回复快照写在剧情 `state/template.json`，组装读改写共用工作区锁；分支复制此文件，WAL 回滚同步撤销。动态模板进 turn，不钉入 standing。正常 stop 回复在 turn/end 清理缓存、提交 WAL 前处理；UI 通过消息 seq 读取快照，预览和重绘不产生持久写入。详细接口及与 ST 的差异见 [模板说明](PROMPT_TEMPLATES.md)。

消息变量由宿主稳定 Message.id 定位，historyIdentities 与过滤后的文本历史严格对齐，消息 seq 仅用于展示定位。新输入与普通 stop 回复一次继承前序快照；withMsg 修改历史目标也归当前执行楼层的 WAL。冻结上下文只包含当前剧情可见的快照，旧单树不用于推断缺失历史。快照摘要与条件/schema 校验共同覆盖直接引用写入。

sticky 的 prompt、generate regex、message regex 分别在成功组装结束、成功组装结束、下一轮开始推进，缓存命中与预览不另行提交。prepared 期间 generation 保存单份执行日志，continuation 引用它；收口时仅为仍活跃的回调保留日志。阶段切换、消息元数据和回复操作一起重放，共享词法变量保留，旧增量仅发生于重建副本。预加载资产指纹与权威注册表阻止过期规则复活；最后一个回调到期后可释放旧日志。变量、消息快照、计时器、注册表与回执始终同文件提交。

世界书装饰器先归一化；@@if 在隔离 worker 内只读筛选后才参与 WI 分组和预算，命中的条件条目强制进入 turn。每次 QuickJS 建立时重建预加载函数与缓存默认值，不持久化预加载副作用；生成与回复沿用冻结资产。JSON Patch 在副本上验证整批操作后再调用统一变量写入，模板失败仍拒绝整个回复提交。

WI 扫描、预处理和组装由同一 worker 计划完成；activewi 新请求触发同轮重组，QuickJS 按来源缓存求值，所有迭代使用同一轮初定时器。动态正则只在 QuickJS 内执行；修改插件静态内容时移入 turn，历史改写只出现在模拟序列。跨阶段仅传递字符串回复规则，局部闭包在渲染前/预加载时重建。

模板依赖构建为 `lib/vendor/template-libraries.js`：Zod、Lodash、jsonrepair 只在 QuickJS 中求值，不桥接 Node 函数。库加载前先固定沙箱 Date/Math.random，避免 Lodash 捕获宿主时钟。变量 schema 在副本上完成校验与转换，失败不发布；成功写入记录校验后的状态指纹，导出不会再次运行非幂等转换，绕过 setter 的持久引用改动仍需通过校验。

Faker 构建为单独带许可证的 `lib/vendor/template-faker.js`。worker 只把脚本文本复制进 QuickJS，首次使用时由沙箱加载；全语言数据按需 JSON.parse，默认实例使用冻结 seed/now。角色读取快照包含 ST 根字段与 data 字段但不含 PNG/raw；普通 WI、渲染和预加载均提供 world_info，省略库名的嵌套读取保持当前条目来源。

变量变更时，生成计划把 WI 定时器一同提交到模板文件的可选 wiTimers 字段，消除两次 rename 之间的半提交。未迁移的会话继续读取旧 wi-timers 路径；已迁移会话的普通计时更新也只写模板文件。pendingTurnPlans 只暂存已组装但尚未提交的绝对快照，提交成功才发布正式 turnPlans，楼层结束时清理。分支将边界定时值写子会话旧路径，不修改复制的祖先模板文件；子会话首次变量更新再在自己的楼层内迁移。

定位条目由纯解析器识别，参与 WI 选择但从普通位置桶移出，避免重复注入。worker 在组装后处理 GENERATE 正文追加、@INJECT 位置/角色插入、@INJECT 正则插入，再检查总预算。精确定位仅修改模拟 messages 副本，真实内容追加到 tavern:turn，standing 与宿主历史保持其原有职责。重组重放定位来源缓存，正则目标通过正文指纹和重复次数识别，位置变化不会重复执行同一模板。

WI 正则、提示词组装和 output/render 正则都在 Node worker 内运行。每次计算上限 1 秒，启动上限 10 秒；最多两个并行、十六个等待任务，输入/输出各上限 16 MiB 字符，worker 老生代上限 128 MiB。超时/超量明确失败并终止 worker；静态 regex 检查不作为最终安全保证。Node 24 源码测试映射本项目相对 .js 导入到 .ts；发布运行只加载 lib JavaScript。

remote 的方法键集合、请求 schema、结果表、service 和客户端映射由编译约束。React 与宿主 primitives 使用真实公开类型，运行 bundle 保持 external，不使用 any 声明掩盖错误。

关键测试：storyIsolation（真实存储与宿主分支）、transactionRecovery（故障注入与来源）、robustBoundaries（真实 worker 和终止协议）、pipelineCache（同轮冻结）、floorConcurrency（工具事务）。这些测试不调用真实模型；宿主 UI 与实际安装仍需要另做冒烟。
