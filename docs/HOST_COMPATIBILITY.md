# 宿主兼容记录

这些是 dsh 0.1.2-rc.1 的观测结果，升级时重新核对，不是永久架构要求。

## 宿主版本注记与升级（当前 dsh 0.1.2-rc.1）

以下行为绑定 0.1.2-rc.1，升级宿主时逐条复查（以官方文档和宿主源码为准）：

1. `Session.events` 数组属性已移除：读全量用 `snapshotEvents()`（下次追加前缓存复用，放心多次调），单条 `eventAt(seq)`，日志长度 `session.seq`。`header.seedLength` 移除：fork 继承前缀长度是 `session.inheritedEventCount`；`agents.create` 的 meta 写 `isSeeded: true` + 顶层 `inheritedEventCount`（与官方 `SessionStore.fork` 同形）。
2. 会话预设判定：`resolveSessionPreset` 帮手移除，官方路径是 `agentPreset` 会话投影；插件封装在 `sessionPresetId`（投影缺席时手动折叠 header + `agent-preset/selected` 兜底）。
3. client 侧：「新对话」动作从 `ctx.workspaces.startSession` 迁到 `ctx.uiWorkspace.startSession`（seatWatch 双路径兜底）；`dsh-client-runtime` 包删除，`dsh.client.inject` 不再需要（bundle 只 require seed 词：react 系 / cordis / ui-slots / ui-primitives）；`dsh-client-web-react` / `dsh-client-schema-form` / `dsh-client-ui-attachment` 均不在 seed。chat.node 图片用 owner 的 `renderMessageImages`；`fileMentions` 是 owner 函数，先解析再传给 MarkdownText，必填 `labels` 用 `useMarkdownLabels()` 获取。界面语言 auto 档经 `ctx.locale.getSnapshot().active` + `subscribe` 跟随宿主（LocaleRuntime）。会话列表摘要 `SessionSummary` 顶层不再有 `agentPreset`，预设 id 只读 `projectionValues.agentPreset`（`src/client/mode.ts`，读错位置会让全部会话面 UI 静默）；`SessionSnapshot` 移除 `composerPhase`，英雄区空会话判定用 `blank && !promptAttempted`。
4. 杂项迁移：`settingsNamespace()` 帮手移除（`settings.register` 直接吃字面量）；`JsonValue` 从 `dsh-session/types` 挪到 `@deepseek-ai/dsh-util-values`。dsh 把大量运行时依赖改写成了 peer（`dsh-jobs` / `dsh-session-persistence` 等基础包不再自动安装），本仓库 `legacy-peer-deps` 下这些宿主内部包必须显式列进 devDependencies，且 cordis / schemastery 要跟随宿主版本（当前 4.0.2 / 3.18.2）。
5. web 设置 RPC 无命名空间白名单（rc.2 起，0.1.2 仍成立），宿主通用设置页也能看到/改 `dsh-tavern` 的键——宿主行为，不要为此改插件面板。
6. 会话头宿主原生面包屑（`conversation.session.header.lineage`）与楼层级 ‹ n/m › 互补，不要替换那个 slot。
7. primitives `Modal` 的 dialog 外壳自带 `width:min(380px,100%)`：弹窗宽度档（`Dialog` 的 md/lg/xl/full）必须经 `className` 落在外壳上，挂在 `contentClassName`（内容层）会被外壳宽度卡住不生效。
8. 插件直接追加开场白的 `turn/start` 会推进服务端 `sessionListMetadata.blank`，但不经过客户端 `session.send` 的 blank 更新路径；成功后调用 `sessions.refresh()` 同步会话列表，避免「新会话」复用和英雄区预览残留。绑定读取附带日志判定的 `conversationStarted`，用于防止 blank 镜像滞后时误清绑定。
9. Vue 全局构建的模板编译依赖 `Function`。交互卡 srcDoc 在 `sandbox="allow-scripts"` 的 opaque origin 内允许 `unsafe-eval`，包括 `document.write` 重写后的文档；不增加 `allow-same-origin`、主窗口桥或默认网络访问权限。
10. 卡面酒馆助手兼容见 [接口说明](TAVERN_HELPER.md)：真实会话以用户可见 append 事件建立连续消息下标，变量使用稳定消息身份落在 state/helper.json，经剧情锁/WAL 提交；分支快照包含此文件。opaque-origin iframe 只获得固定会话/消息的变量业务桥，预览没有持久化能力。重绘不能丢失保存回执；卡面替换、切换会话后丢弃旧回复。历史改变、生成中、旧表冲突和坏日志必须拒绝写入。
11. 备份恢复必须创建新 iframe 文档。直接 `document.write` 重跑第三方页面会留下顶层词法绑定并触发 const 重声明；跨 opaque-origin 刷新也不能依赖窗口名传递数据。文档内的常规 rewrite 仅用于加载卡片内容，桥只装一层原生包装，重装前清理旧观察器与定时器。
12. 手机设置布局：`dsh-client-ui-settings-general` 的设置 dialog 在 390px 视口中宽 342px，仍保留 188px 导航及正文两侧 48px 内边距，使 Tavern 正文只剩约 98px（含滚动条差异）。`styles.ts` 在视口不超过 560px 且 dialog 含 `.dsh-tavern-panel` 时，把原导航按钮排成横向滚动顶栏；通过直属 `nav` 与相邻正文结构限定外壳，未替换宿主节点或改其状态。其它设置页/桌面恢复宿主样式；升级时核对 SettingsPanel 结构。主会话侧栏由 `dsh-client-ui-layout` 在低于 1024px 时自动折为 56px，手动展开由用户控制，插件不调用 toggle 强制修改桌面宽度。手机弹窗使用动态视口高度和 flex 正文滚动分配，第三方 iframe 内部是否响应式仍由卡片自身实现决定。
13. 后台角色脚本运行器挂在会话头部，面板隐藏时 iframe 保留，暂停/解绑/切换会话时卸载。脚本正文通过 JSON 编码的可信引导创建内联 module，不在主页面执行；脚本按钮和异常展示留在沙箱。剧情变量初始化仅发生于缺失的 script 表，重启不得补回已删除字段。
14. 剧情事件由主页面固定 sessionId/storyId 分组，消息来源须匹配 iframe 窗口；运行时 epoch 用于拒绝旧文档回执。监听在各自沙箱执行，父页面仅排序、转发有界 JSON 和等待回执。重入事件不持有全组串行锁；停止/重写移除监听，超时明确失败。同步入口不能同步等待跨 iframe 回调。

15. 重启后浏览旧会话可能只有持久日志，`ctx.sessions.get` 只返回已在线的 Session，不能据此判断“没有开场白”。展示与空白判定优先在线日志，否则使用 `ctx.sessionPersistence.inspect` 的不可变检查结果；不能用会修复并写盘的 `load`，也不能为展示调用 agents.resume。已验证冷会话 EJS 开场白可读且不落模板变量。
16. rc.1 的输入和 assistant Message 都有稳定 `id`。按消息模板变量使用该 id，不能由正文或事件 seq 推断；编辑后的新 Message.id 即使沿用 seq 也不能复用旧快照。历史投影仅使用 deriveMessages 可见消息，并按 inbox id 对待入日志输入去重。真实分支复制继承消息 id，变量和 sticky 仍随 story 文件独立推进。
17. 角色脚本编辑器只经类型化 remote 保存共享角色资产，使用资产锁和脚本树修订，保留同期更新的角色字段。写盘成功但回执失败时必须失效缓存，重试相同目标值不重复写入；剧情 script 变量不随资产编辑重置。当前浏览器工厂冒烟已验证真实 React 编辑和文件落盘，不能代替安装环境的宿主 boot/UI 验收。

18. 全局和预设脚本资产与普通预设写入共用数据根锁。全局库无缓存，预设写入即使回执失败也失效缓存；普通预设表单不能覆盖脚本管理器中的最新设置。运行器按绑定的 presetId 选库，异步加载末尾重新核对绑定，不能把旧预设代码安装进新绑定。脚本沙箱仅得到有界三库快照，仍无通用资产/文件桥。

19. 沙箱脚本库写入持有绑定锁，再进入对应资产锁；目标 ID 从绑定派生，旧 preset/story 的令牌拒绝。保存回执先送到来源窗口，沙箱确认后才通知后台重载；React 普通重绘不丢回执，srcDoc/剧情切换后丢弃旧回包。序列化到 iframe 的解析器依赖显式传参，不依赖构建器模块变量；构建产物已做真实浏览器 SDK 保存冒烟。

20. 现代世界书 SDK 通过固定会话/消息桥读写；公共库从目录 ID 或唯一原始名称解析，角色内嵌书和聊天书使用固定别名。旧绑定令牌不能写入新剧情；聊天书仅在正常完成楼层内经 WAL 保存。updater/predicate 留在沙箱，条目正则不会在主线程运行。构建产物已通过真实浏览器世界书保存冒烟，验证公共书读取修改、正则关键词转码、聊天书落盘与完成楼层 WAL；此工厂验证仍不能代替安装环境 boot/UI 验收。

21. 旧 lorebook 条目接口只在沙箱转换字段并复用现代 worldbook 桥，不添加新 remote 权限。局部更新必须保留未指定字段、未选中条目及现代 extra，UID 无效整批拒绝。组内计分支持条目覆盖全局，先过滤启用计分的低分候选，再按 override/权重选择，同分仍可加权。新增可选字段也须纳入模板恢复的严格 schema：保留 true/false/null，兼容旧快照缺省，坏类型拒绝。旧接口的构建产物已做真实浏览器 CRUD、部分更新及聊天书 WAL 冒烟。

升级 dsh 的检查清单：

- 模板回复处理依赖 `assistant/chunk` 的唯一末尾 `finish.reason.kind=stop`、`assistant/message` 的 seq/turn/step 与 `turn/end.reason.kind=completed`。必须在当前楼层关闭前保存展示快照；client 的 finalNode.seq 传给只读渲染接口。升级时核对这些真实字段和 turn 状态，不能在刷新回调中执行持久脚本。
- `package.json` 三处版本同步：`peerDependencies`、`overrides`、`devDependencies`（全部精确版本，不带 `^`）。
- 逐条复查上面注记在新宿主上是否仍成立，失效的改掉并从本节删除。
- 对照官方文档的 breaking changes：slot、profile/bundle、patch 层顺序、system-prompt 瀑布、agent 事件、session 读取 API、client seed 模块表。
- `npm install` → `npm run build` → `npm test` → `npm pack --dry-run`，再 `npm run dev` 实机冒烟（peer 缺失只会在宿主 boot 时暴露）。
- 扫描宿主包的非可选 peer：缺失的宿主内部包补进 devDependencies；cordis / schemastery 等跟随宿主版本（0.1.2 起宿主大量依赖改写为 peer，`legacy-peer-deps` 不会自动装）。
- 在 `CHANGELOG.md` 记一行适配的 dsh 版本。


另见宿主源码：`dsh-agent-loop` 在 buildRequest 中深度冻结 GenerateOptions；`dsh-llm` 的 llm/stream waterfall 可观察请求，但 next() 不接受替换消息。本插件只读观察，不在中间件另起调用。

22. 世界书绑定桥只修改固定会话。主书显式关闭与角色附加书进入真实管线及修订标签；同轮修改仍重放冻结计划，下一轮生效。聊天活动书、闲置副本与选择共存原有 chat-lorebook.json，切换/解绑按完成楼层 WAL 原子保存，分支复制后独立；@dsh/chat 是主书固定标识，其它私有书须使用 getter 返回的标识。绑定回执更新令牌，拒绝迟到 updater；不确定保存失败先刷新再重试。真实文件系统测试覆盖副本复用、回滚、分支、损坏日志与写后报错。 构建产物的真实浏览器工厂已验证新旧绑定接口、切回保留修改、解绑保留内容及磁盘 WAL；真实 React 面板测试验证无主书/附加书保存。这些验证仍不代表安装环境 boot/UI 已完成。

23. 旧世界书设置适配为会话绑定内的部分引擎覆盖，绑定令牌含实际引擎设置，旧令牌拒绝提交；同步 setter 先改沙箱快照，flush 等待串行持久化，失败保留草稿并明确显示。设置与全局书选择在同一次绑定保存中应用，管线使用覆盖后的设置，同轮计划冻结不受影响。最少激活扩深与递归共用一次求值，保持条目固定扫描深度、总轮数与预算约束，定时器只推进一次，概率失败不重掷。 构建产物已通过真实浏览器工厂验证：连续同步设置、等待持久化、磁盘部分覆盖、实际扩深命中与 3000 token 预算一致。此工厂不代替安装环境 boot/UI 验收。

24. 助手消息正文编辑不使用 surface replace 冒充可见历史修改，而是通过 agents.create 的独立分支保留完整后续消息。修改后过时的 surface replace 和相关压缩记录替为 ignorable 插件标记，日志 seq 保持连续，原始 append 重新进入模型视图；被改消息的旧 chunk 及 sourceEventSeqs 不再用于展示新正文。正文替换保留非文本块；新 seed 必须通过 Session.create 校验，再准备剧情 WAL 回滚、发布并绑定子会话。真实 Session + 文件系统测试覆盖压缩后的编辑、后续正文、WAL 损坏、创建失败及准备期间新增事件；真实 React/SDK 测试覆盖回执确认后导航与迟到回执隔离。 构建产物的真实浏览器工厂已完成跨沙箱批量编辑、确认回执、压缩后模型视图与分支事实回滚验证；原会话仍保留原摘要和全部事实。此工厂不代替安装环境 boot/UI 验收。

25. 消息 data/extra 不改宿主日志，按稳定 Message.id 同存剧情 helper.json；普通变量提交必须保留 extra。纯数据批量写入当前完成楼层，正文混编在回滚后的草稿中写新身份；snapshotStory 提供的复制句柄不携带 WAL，显式数据必须另建绑定草稿 Wal 的 WorkspaceFs，以保证再次分支/回滚可撤销。旧格式没有 extras 时按空表读取，畸形表拒绝加载。真实 Session/文件系统测试覆盖源剧情隔离、子会话 WAL 撤销、并发 CAS、历史变化及写失败；SDK 测试覆盖等待期间本地变量不丢失与后续串行保存。 构建产物的浏览器沙箱已验证先纯数据保存并即时读回，再混编正文和数据；子剧情保留后续正文与显式数据，来源保持原数据、全部事实和摘要。此工厂仍不代替安装环境 boot/UI 验收。

26. getChatMessages 返回的完整消息和当前 swipe 页可经 SDK 归一后写回，宿主桥仍仅接收 message/data/extra 等固定字段。保持原值的名称、角色、隐藏状态及旧角色标志作为一致性检查；修改它们或未选中页会失败。当前页始终反映真实消息正文和剧情 data/extra，不能用角色资产中的旧开场白覆盖已编辑正文。不同表示只有一处变化时采用新值，矛盾的新值拒绝整批执行。 构建产物的真实浏览器沙箱已验证完整消息对象的数据写回、当前 swipe 页的正文/变量/元数据混编及原剧情隔离；宿主分支创建仍使用模拟适配器，此验证不代替安装环境验收。

27. 完整 swipe 按稳定消息身份保存在 helper.json 的 swipes 中，每页正文/data/extra 独立；当前页变量仍以普通 message 作用域为准，快照与 SDK 均投影最新已保存值。切换选中下标或当前正文修改采用真实 Session 编辑分支并撤销派生事实，未选中页修改直接经完成楼层 WAL。页集合及其数据在草稿回滚后用带 Wal 的 WorkspaceFs 保存，旧值冲突、坏页集合和写失败均在发布前拒绝。真实 Session/文件系统测试覆盖多次来回切页、重启、相同正文切页、来源隔离、子楼层回滚和故障；构建产物的真实浏览器沙箱已验证新增页、读取每页数据及切页后的实际模型历史。宿主创建仍为模拟适配器，安装环境 boot/UI 和生命周期事件验收待完成。

28. 真实会话旧消息/Slash/上下文入口只调用现有 setChatMessages 事务，避免旧闭包仍直发开场白桥。上下文保存限定原 story/historyRevision，并比较改动行的最新数据；不传整段未改历史。草稿数组与行引用保持，确认回执后按字段合并继续编辑，分支回执不重写旧页面草稿。variables/swipe_info 只作为完整页数组别名，冲突拒绝，结构性聊天变更仍未适配。预览保留已有开场白选择。 构建产物的真实浏览器沙箱已验证通过原生风格上下文新增页和保存变量/元数据，再由 /swipe 切页；子会话模型历史和页数据正确，来源未改。此工厂使用模拟宿主创建适配器，仍不代替安装环境 boot/UI 验收。

29. 删除不原地改宿主会话：可见 user/assistant 消息替为不含原内容的 ignorable 标记；assistant 同一步 chunk/tool call/result 成组移除，turn/step 边界保持，过时 surface replace 与 compaction 清除。相同步骤有多个独立 assistant 时拒绝歧义目标。剧情草稿回滚后显式清除删除消息的 helper scope/extra/swipes，其余混合修改按原 seq 定位新消息，不能沿用删除前数组下标。真实 Session 及其官方关系不变量伴随插件验证工具配对、完整删除 66 条后继续回合、坏 WAL/宿主失败和来源隔离；React 验证来源固定与回执后导航，SDK 支持 100 条以上的单批请求。构建产物的真实浏览器沙箱已验证压缩历史中的批量删除、后续正文及事实回滚，原会话保留摘要和全部事实。此工厂使用模拟宿主创建适配器，仍不代替安装环境 boot/UI 验收。

30. 消息重绘只针对当前页面已挂载插件气泡，宿主原生用户气泡与原生渲染事件仍待适配。固定 sessionId/message seq 由气泡提供；SDK 只提交 storyId/historyRevision/连续可见下标。准备阶段保存发起卡变量、保护目标卡变量/脚本/世界书/上下文草稿及卡外恢复表单，拒绝准备期间新业务请求；全部准备后等待来源沙箱确认才替换，失败/超时/卸载取消旧准备。正文仍通过既有只读 renderOutputText，不重新提交模板。真实 React/SDK 测试覆盖来源与历史校验、准备失败、重复刷新、相同正文、草稿、超时和迟到确认；构建产物的真实浏览器验证使用实际 SpeechBubble、Session、TavernService 渲染及变量 WAL，连续三次独立沙箱加载后变量保留、日志事件数不变。仅宿主 primitives 外壳和 remote 传输为工厂适配，此验证仍不代替真实安装环境 boot/UI 验收。

31. 插件气泡生命周期从真实卡面就绪信号产生，来源窗口与当前 helperEventConnect 运行时身份同时校验；一条消息的全部 HTML 块就绪后只发送一次 CHARACTER_MESSAGE_RENDERED(id, normal)，Markdown 在 React 提交后发送，流式与旧文档不报完成。all 重绘等待所有目标的显示及监听回执，再发送 CHAT_CHANGED(storyId)。宿主发布者复用有界 JSON 顺序路由，监听前同步最新剧情；快照准备失败保留 once，执行后失败不撤销已保存结果。真实 React、多卡面/旧身份/回执确认测试及编译 SDK 测试已覆盖；真实浏览器工厂使用实际 SpeechBubble、Session、TavernService 和 WAL，三次独立沙箱加载依次观察到 rendered(0,0)、rendered(0,1)、rendered(0,1)、chat(1)，宿主日志不变。此工厂仍不代替安装环境 boot/UI 验收。已核对 0.1.2-rc.1 的 ISessions.binding().eventSource 提供同步 replace/prepend/append 日志窗口；实时订阅只消费当前 Tavern 会话同步 append，并在 replace 时取消旧任务，prepend 不回放；可见序号由服务端完整历史投影，正常接收必须经过对应 turn/end 的成功收口回执与 WAL 验证。非正常轮次仅通知停止。宿主事件使用 prepare/execute 许可防止迟到来源执行和准备超时丢失 once。旧气泡/clean 沙箱刷新先同步权威修订，等待首消息的后台脚本随剧情通知启动；已有脚本不因新消息重建。实时浏览器工厂使用最终编译的订阅器、SpeechBubble 与沙箱 SDK，以及实际 Session、TavernService 和剧情 WAL；依次观察 start、sent(1)、received(2)、end(2)，接收监听持久化计数一次，随后 all 使旧/新 iframe 各重建一次，WAL 已提交。只替换宿主原语外壳和日志/remote 传输；实际宿主验收见下一条。

32. 2026-09-06 在 Windows/Node 24 与实际安装的 dsh 0.1.2-rc.1 中完成酒馆助手基础 boot/UI 验收。使用独立临时 DSH_HOME、工厂工作区及 profile/node_modules 到当前 checkout 的 junction；默认 web profile 加项目补丁，无额外模型凭据。真实浏览器通过 Tavern 面板导入手写 JSON 卡，选择工厂工作区与 Tavern 模式、绑定角色并点击“开始对话”，成功显示含 jQuery 的开场白卡面与模块后台脚本。卡面保存 count=1，后台脚本按钮保存 count=2，两个沙箱同步显示 2；refreshOneMessage 重绘与整页重开后均保持 2。核对仅工厂剧情中的 helper.json 为 count=2、对应 WAL committed=true，宿主终端无新增错误，无模型调用。目录选择采用官方 browse 两面替代 native 选择器，仅修改工厂 overlay；没有降低卡片沙箱权限或使用真实用户数据。全部验收页与宿主进程已关闭。这一验收覆盖已实现的基础链路，不代表全部第三方卡、MVU、生成控制与跨页面功能已经兼容。

33. MVU 手动接口在各自 opaque iframe 中运行：同步读取剧情快照，解析顺序等待同剧情可变事件，显式 replace 等待已有 CAS/WAL 回执。真实文件系统与模拟宿主验证消息变量保存、WAL committed、重建后可读和同卡剧情隔离；解析不改宿主正文、不创建分支。编译产物的真实浏览器工厂验证 add 后保存 15、Zod 拒绝负数、字符串 18 转为数字并保存、再次解析由结束钩子钳制为 20；模拟保存失败时存储仍为 20、编辑草稿保留 19，卡面显示错误。schema 留当前 iframe，仅约束编辑器。实际浏览器发现并修复 label 样式覆盖 hidden 属性的问题，复查聊天/消息作用域的目标输入切换通过。工厂的保存传输为内存适配器，文件系统行为另由集成测试覆盖；未将这一工厂称为完整 MVU 卡或安装宿主全量验收。世界书初值、正常 stop 自动更新、经典 schema 和模板变量整合仍待适配。临时页面和服务均已关闭。

34. 原生 MVU 自动模式使用 0.1.2-rc.1 的 agent/turn-stopping 串行钩子，在正常 stop 的 assistant 已追加、turn/end 与下次输入 claim 之前登记任务。等待浏览器不占 session task 队列或剧情锁；真正 idle 由 runMaintenance 同步认领，兜底保留原生输入身份/顺序/目标，取消不伪造唤醒消息。实际开场白既有旧 turn 0，也有 greeting 来源标记的 turn 1（无模型 finish chunk），两者均纳入测试。完成数据与任务回执同写 helper.json；闭合楼层追加 MVU 写先 reopenFloor 保留原始回滚快照，WAL 恢复成功后才确认完成。

2026-09-06 的真实浏览器双沙箱工厂验证：异步模块就绪后初始化 7，经 INITIALIZED 钩子变 10；后续 stop 工厂输入依次得到 15、20，下一次命令到 25 经结束钩子限制回 20，监听读取的当前消息位置为 1/2/3。随后在实际 Windows/Node 24/dsh 0.1.2-rc.1 的独立工厂 DSH_HOME 启动新构建，UI 开启原生 MVU；真实 turn 1 开场白完成初始化，磁盘 pending 为空、完成回执一条、WAL committed=true；原有卡面按钮继续保存 count=3，未调用模型。此验证覆盖初始化和普通变量衔接；正常模型 stop 链路另由真实 AgentLoop/Session 与手写流适配器集成测试验证，未调用真实模型。

本次原生 MVU 工厂整页重载后仍显示 count=3 且没有重复初始化；验收页、浏览器工厂服务与真实宿主进程均已关闭。


### 0.1.2-rc.1 脚本选项输入核对

已核对安装包 `@deepseek-ai/dsh-client-ui-conversation` 0.1.2-rc.1 的公开 `IConversation.input.for(actx)` / `SessionInput.setDraft` 与 `InputState` 类型。脚本选项的可信点击处理经 `sessions.scope(sessionId)` 获取本会话输入面；限制当前会话、plain 阶段、无引用，保留原草稿。此前 AI 代答采用剪贴板仍保持原行为，不能据此推断宿主完全没有可写草稿 API。
