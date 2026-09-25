# 宿主兼容记录

当前源码基线为 dsh 0.1.7-rc.2。以下按版本记录观测结果，升级时重新核对，不是永久架构要求。

## 0.1.7-rc.2 升级核对（2026-09-25）

逐包核对公开 npm 的 package.json、lib 和声明：Cordis 4.0.4、Schemastery 3.18.4；宿主包统一锁定 `0.1.7-rc.2`。

- `dsh-agent-presets` 改为 `dsh-agent-preset-registry`，Tavern 用 register/dispose 管理模式；提供业务 service 后再注册预设以满足立即激活。
- `dsh-settings` 以 Loader 配置和 volatile 值为唯一读写来源，更新后当前实例读取新值；entry id 与旧 `settings.yaml` 的 `dsh-tavern` 节一致。远程 strict codec 必须提供 `create()` 工厂，已移除旧 schema 字段及入口的类型绕过。
- 新消息将 tool/developer 分为独立 role；剧情历史投影必须跳过。runtime-context、system-prompt、compact-checkpoint 采用新版来源；插件 notice 使用声明扩展，并兼容旧 notice。
- 官方 DeepSeek 配置和凭据来自 `dsh-llm-deepseek-api-key`；复用公开适配器的 Messages、Files 协议。同代 prepareCall 冻结连接及能力。中途 system 只允许 user/tool 后、assistant 或结束前，否则合入首条并显示兼容说明；累计完整快照仍有 16 MiB 上限。
- PTC 从 worker-thread codeRuntime 转为 `dsh-ptc-runtime-node` 子进程，真实工具测试启用临时目录沙箱；卡面/EJS 不进入该执行器。
- 客户端改用宿主实际导出的 Medium 图标，仍使用原生 primitives 和不带同源权限的 iframe。

安装验收使用独立 `DSH_HOME`，通过真实 `dsh plugin --profile web add` 安装本地 tgz，再启动 dsh web；修复了启动时才暴露的 strict codec 故障。未配置模型凭据、未调用真实模型，模型请求由真实 AgentLoop、适配器和工厂 HTTP/SSE 测试覆盖。 界面实际完成工作区选择、Tavern 模式切换、手写角色创建/编辑/绑定和开场白显示；设置写入当前 profile，重启后角色与历史恢复。向独立 home 放入手写旧 settings.yaml 后，宿主将其重命名为 settings.yaml.imported，两项提示词偏好迁移后的 UI 值与新 profile 文件一致。浏览器未报告错误，验收页和宿主均已关闭。干净 npm ci（601 个包、审计 0 已知漏洞）、构建、157 个测试文件 / 2263 项通过 / 1 项 POSIX 跳过、doctor/backup 和 441 文件打包白名单检查通过。

## 0.1.5-rc.2 角色卡显示与安装环境 UI 复查（2026-09-20）

在 Windows / Node 24.18.0 / dsh `0.1.5-rc.2` 下，以独立临时 `DSH_HOME` 将与最终发布源码相同的本地 tgz 通过真实 `dsh plugin --profile web add` 安装到新的 web profile，再启动真实 `dsh web`。HTTP 首页返回 200，Tavern 模式、设置入口与角色管理正常；未读取或写入用户原有数据。

- 在真实浏览器中创建、编辑并绑定手写角色，开场白与历史气泡正常显示；角色改名后，气泡标题、历史卡面及后台角色脚本上下文均刷新。
- 动态卡在沙箱内将变量从 0 更新为 1，整页刷新后仍读回 1；相同 HTML 的成功重绘确实创建新沙箱，旧卡在候选就绪前保持可见。故意制造的重绘失败明确报错并保留旧卡，没有部分替换。
- 动态 iframe 仅有 `sandbox="allow-scripts"`，没有 `allow-same-origin`；CSP 的 `connect-src` 继续为 `none`。隐藏候选的只读限制、来源窗口及剧情身份校验没有放宽。
- 明暗主题下卡面与表单均可读。纯静态卡的 `srcdoc` 约 199 KiB，未装入脚本兼容库；动态卡约 817 KiB，仍包含完整兼容运行时。浏览器最终日志无页面错误，验收宿主已关闭且监听端口已释放。
- 本轮没有配置模型凭据或调用真实模型，也未导入任意第三方卡；因此只证明上述安装、卡面、重绘、持久化和安全边界，不声称全部 SillyTavern 卡或模型生成效果均已验证。

同一源码的最终本地验证为：`npm run build` 通过；156 个测试文件中 2245 项通过、1 项 POSIX 专属用例按预期跳过；439 文件发布白名单、差异格式检查通过。正式 Release 附件仍只使用最终提交通过 Windows/Ubuntu CI 后生成的安装包及校验和。

## 0.1.5-rc.2 分支输入队列边界（2026-09-19）

已核对 `dsh-agent` 的 `AgentSetup(agentCtx, agent)`、`Inbox.clear()` 与 `dsh-agent-loop` 的 setup/publish 时序。rc.2 通过 `agent/inbox/spliced` 持久化 next-turn/next-step；`session/end-seed` 不会清空队列。楼层前缀可能留下已入队、尚未消费的输入：回退后下次发消息会重放它；重新生成在 turn/start 前截断，再显式 followup 时还会重复处理同一输入。

分支统一在 setup 中先清空子 agent 的继承队列，再挂载预设；宿主在发布前将 setup 追加的取消事件写入存储。该操作不驱动模型、不修改来源会话，也不改变旧事件的序号、surface 引用和 inheritedEventCount。取消日志使重启后的队列投影同样为空；不采用发布后临时清内存或删改历史 splice 的方案。旧分支不自动迁移，需更新并重新回退。

真实 AgentRegistry、AgentLoop、Session、临时剧情目录与手写模型适配器回归：修复前复现回退续聊重放旧输入、重生成重复输入、编辑用户消息先执行旧内容；修复后四项通过，另覆盖助手删除分支的两类队列、发布时日志与后续日志冷重放、父会话日志和排队输入不变。冷重放使用真实 Session 重建快照，未调用真实模型或执行浏览器点击，也不是完整磁盘持久化后端重启验收；发布前写盘顺序另按 rc.2 宿主源码核对。

## 0.1.5-rc.2 PTC 返回值边界（2026-09-19）

核对 `dsh-tools` 与 `dsh-code-runtime-worker-thread`：子工具输出在交给程序前已经过无损 JSON 与 schema 校验；程序重组结果后的最终完成值另行校验。例如成功的写工具没有 `error` 字段，`return { ok: r.ok, error: r.error }` 会产生 `invalid-output: program completion must be lossless JSON`。顶层不返回值是允许的，不能把此错误归因于漏写 return。短写入结果可直接 `return r`，或对选取的可选字段使用 `?? null`。

真实注册表、worker、Session 与临时剧情文件回归已复现上述错误：外层失败后子调用仍成功、记忆仅写入一条、同轮落盘确认保留，正常楼层 WAL 回滚可撤销。原样返回与 null 投影均覆盖成功、相似记忆拒绝和未开楼层拒绝，并保留失败信息。截图未提供完整调用代码，回归证明的是这类失败机制，不认定截图中的具体错误字段。测试使用工厂数据，不调用真实模型。

## 0.1.5-rc.2 预设真实请求核对（2026-09-19）

核对已安装 agent、agent-loop、system-prompt、llm、session 的 package.json、公开声明和 lib：实际顺序是 `systemPrompt.assemble → agent/pre-step → step/start → agent/request → system/user 日志提交 → deriveMessages`。因此采样可读取本轮已冻结计划；后续请求从已记录的 header 起步，空 stop 必须清除上一轮插件值，maxTokens 回退只恢复显式 AgentOptions 上限。

runtime context 是 user 快照，且跨轮也按正文去重。PHI 仅移动到 turn 而不改变本轮标记，会在第二轮留在旧位置；当前为包含历史后/depth=0 指令的计划加冻结轮号。`agent/pre-step` 只接收 UserMessage，`agent/request` 不接收可替换 messages，llm 边界深冻结；这些公开接口不能提供精确非零深度或 assistant prefill。

`presetLiveRequest.test.ts` 使用真实 AgentLoop、Session、SystemPrompt、临时剧情文件和手写 LlmAdapter 流，验证连续两轮尾部指令、卡级覆盖、同轮工具后的计划冻结、下一轮采样更新及停止词清空；图片和工具消息保持宿主结构，WAL 正常提交。没有调用真实模型，不将这些结构检查称为生成质量验证。

同日补查 `llm/stream` 的 `next()` 无替代 options 参数，session-projection 不提供完整消息布局。此前修复内建标记往返、同序号稳定排序、同深度角色排序、常用宏及格式字段，并新增全局角色覆盖偏好；随后将 DeepSeek 官方普通聊天接入自持有公开适配器的布局投影，仍未升级宿主或另开普通聊天调用。布局通过合法 user/message 的可扩展 source 保存，原宿主消息与工具前缀保留。其它供应商仍采用两段映射，真正 prefill/prefix 仍需供应商编码支持；结构测试不保证模型遵循所有指令。

进一步核对 rc.2 `LlmResolvedModelInfo.systemPromptUpdate`：`in-history` 是“最后一条 system 为完整有效提示”，未声明则只读取首条 system。已准备模型能力与 endpoint、凭证等一同冻结；途中 system 使用累计完整快照，保留 SDK、其它宿主系统段及先前系统预设，只读首条的模型则合并系统指令并显示兼容说明。不能仅凭 wire 第一条仍有 SDK 就断言它未被后续 system 替代。真实 AgentLoop 与手写 HTTP/SSE 同时覆盖这两类模型。

最终验证：原位 `npm ci` 成功，依赖审计 0 项已知漏洞；构建通过，154 个文件中 2168 项测试通过，Windows 跳过 1 项 POSIX 用例。`npm pack --dry-run`、437 文件发布白名单、doctor 与 backup CLI 检查通过。使用独立临时 DSH_HOME、Windows / Node 24 / rc.2 加载最终构建并重启，真实浏览器确认 Tavern 模式、设置入口和预设面板正常；重启期间仅出现预期断线重连警告，未出现页面错误。此冒烟没有调用真实模型、导入用户资产或改动用户宿主，普通请求角色、图片上传、工具多步、路由切换及磁盘恢复由真实宿主对象与工厂 HTTP/SSE 集成测试覆盖。临时页面和验收宿主已关闭；这些检查不代表任意预设的生成效果已获验证。

### v0.3.0 发布前的全工作区复查

本次将预设、宏、模板、实际请求、卡面与显示重试、MVU beta、PTC 纪律及分支输入队列的全部未提交改动统一审查。进一步修复模板和实际布局的聊天深度不一致、纯图片身份丢失、宏 fallback 混入通知、纯空白覆盖语义、官方别名关闭思考的回退、非法 in-chat 深度晚失败，以及列表/引用中 Tab 代码围栏列偏移问题。相关用例先复现错误再验证修复。

请求投影缓存重复锚点和插入边界，覆盖 2,048 条历史与 8,192 个同边界/相对插入；相邻自有 system 合并后再生成完整快照，保留宿主消息边界和稳定 ID。请求诊断在序列化前剥除私有布局，诊断失败不阻断发信；文本窗口估算明确排除图片、工具编码和供应商封装，超限只提示，不按粗估丢弃指令。

v0.3.0 本地最终构建通过，154 个测试文件 / 2187 项通过，Windows 跳过 1 项 POSIX 用例；独立目录使用相同 manifest、锁文件和 .npmrc 完成干净 npm ci，审计 0 项已知漏洞。437 文件发布白名单、doctor/backup CLI 与差异格式检查通过。发布附件使用最终提交通过 Windows/Ubuntu CI 后生成的安装包，安装包的启动验收和 CI 链接记录在 GitHub Release 中。

升级需完整重启后台；旧导入预设重导入才能补回此前未保存的字段。in-chat 深度须为非负安全整数；旧负数、小数等非法深度须先修正。纯空白格式或覆盖现在清空对应内容。其它供应商的两段映射、专用助手预填、模型窗口与实际生成效果边界仍保留，不将本次修复宣称为全量 SillyTavern 等价实现。

## 0.1.5-rc.2 真实宿主 UI 复查（2026-09-16）

在 Windows / Node 24.18.0 / dsh `0.1.5-rc.2` 下，以独立临时 `DSH_HOME` 加载最终构建的 `lib/index.js`。工厂 overlay 关闭自动目录选择器并挂载官方 browse 后端与客户端两面；Tavern 预设指向当前 `lib/agent.js`。

- 在真实浏览器中添加工厂工作区、切换 Tavern 模式、创建和编辑手写角色卡、绑定角色并开始对话。
- HTML 沙箱 iframe 保存工厂变量 `smoke_count=7`，浏览器整页刷新后仍读回 7；切换备选开场白创建真实子会话，核对来源剧情的 helper 状态保留与子剧情的楼层回滚，随后在子剧情保存记忆与世界变化。
- 宿主重启后，子剧情的记忆与世界变化各保留一条；返回来源会话仍可从卡面读回变量 7，来源面板的记忆与世界变化均为零。只读提示词预览可以打开并展示 standing 模拟结果，最近宿主请求为空，与未发起模型调用一致。
- 在旧构建的世界书关键词输入框键入 `/\d{1,3}/, 港口`，UI 与磁盘均复现被拆成三个关键词；重建并重启实际宿主后，同一路径在 UI 与磁盘均确认保存为两个关键词。修复同时应用于主、次关键词，词法扫描不执行用户正则。
- 角色卡局部保存忽略 `undefined`，避免清空未提交字段；真实文件系统与 service 回归验证重新读取、导出仍保留其它字段，显式空串、空数组和深度提示 `null` 仍可清空。

本批新增 7 项回归，未发布版本累计新增 41 项；全量 129 个测试文件、1702 项测试通过，构建、doctor CLI 冒烟和 npm pack 白名单检查（405 个文件）通过。浏览器无错误日志，仅记录主动停机重建期间的连接重试；验收页与工厂宿主进程已关闭。未配置模型凭据、未调用真实模型，也未使用真实用户剧情；此次验收覆盖上述工厂交互与持久化路径，不代表全部第三方卡或模型生成链路已经通过验收。

## 0.1.5-rc.2 升级核对（2026-09-14）

- 全局 CLI 与项目内宿主包升级到 `0.1.5-rc.2`；peerDependencies、overrides、devDependencies 同步精确版本，锁文件重新解析。React / React DOM `18.3.1` 显式作为测试开发依赖，与 react-test-renderer 一致；客户端仍使用宿主提供的 React。
- `assistant/chunk` 不再是持久事件。`assistant/message.data.stream` 保存该消息的完整定时流，未产生正文的尝试为 `assistant/attempt`；assistant 不再允许 sourceEventSeqs。正常收口只认可该消息自身流中唯一且位于末尾的 stop，不能借用同一步重试的 finish；开场白使用空 stream。正文编辑清空过时的嵌入流，消息桥同步清理对应尝试记录。
- 冷会话读取改为 `sessionPersistence.open(id, 'read')` → `handle.read()`，在 finally 中关闭句柄。归属校验、读取故障传播及在线会话优先保持；不取得写所有权或为了展示执行恢复写入。
- `AgentLoop.create` 为异步。Inbox 由宿主 session projection 驱动，在 session/event 通知前已经更新；MVU 从有游标的日志折叠中读取 splice 前的输入，保留原消息 ID、队列目标和顺序。真实 Loop 回归覆盖拒绝、取消、维护等待、显式删除与日志重放。
- PTC 子调用日志改为 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`；原生 PTC、多读并发、写入屏障及 standing 位于 TOOLS_SDK 后的回归通过。



验证：Windows / Node 24.18.0 下，127 个测试文件、1572 项测试全部通过；build 与 pack dry-run 白名单（401 个文件）通过。最终 lib 在独立临时 DSH_HOME 启动实际 dsh 0.1.5-rc.2，浏览器添加工厂工作区并创建会话，切换 Tavern 模式后出现角色选择入口。工厂 overlay 仅把目录选择器替换为官方 browse 两面；未配置模型凭据、未调用真实模型或写入真实剧情。验收页与宿主进程已关闭。这是基础 boot/UI 冒烟，不代表全部第三方卡或真实模型链路验收。

## 0.1.2-rc.1 历史观测（接口变更以上方新版本记录为准）

以下行为绑定 0.1.2-rc.1，升级宿主时逐条复查（以官方文档和宿主源码为准）：

2026-09-14 工具调用核对：原装 ptc 预设在 agent 面挂载 `@deepseek-ai/dsh-agent-tool-presentation`（`mode: ptc`），复用宿主 `codeRuntime`；Tavern 采用同一入口。`ToolRuntime` 仅向模型发送 `run_code` schema，七个 Tavern 业务工具的参数/规范输出进入 SDK，子调用仍经宿主策略管线、作用域与并发调度。四个读工具声明可并行，写工具保留独占屏障；`ok=false` 为可检查的业务拒绝，宿主错误以 `ToolCallError` 拒绝。rc.1 的 `TOOLS_SDK` 顺序为 5000，standing 使用公开 `getSectionOrder('TOOLS_SDK') + 10`；旧 order 210 会早于 PTC SDK，因此同步修订约定并递增 standing pin 版本。

验证：真实注册表、Agent、SystemPrompt、WorkerThreadCodeRuntime、Session 与临时剧情文件覆盖一次程序多操作、读取重叠、写后读、相似记忆更新、路径/楼层拒绝、WAL 回滚、步骤通知去重和普通模式隔离；实际组装断言工具前缀早于 standing、相同组装字节不变。全量 126 文件/1568 测试、build、pack dry-run 通过。在独立临时 DSH_HOME 启动 Windows/Node 24/dsh 0.1.2-rc.1，浏览器创建工厂工作区、将空白会话切换为 Tavern，成功显示角色选择入口。目录选择在工厂 overlay 中使用官方 browse 两面；预设指向当前 lib，未配置模型凭据或调用真实模型，未测实际模型延迟。测试页与宿主进程已关闭。

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

34. 原生 MVU 自动模式使用 agent/turn-stopping 串行钩子，在正常 stop 的 assistant 已追加、turn/end 与下次输入 claim 之前持久登记任务，随后立即返回，不把浏览器变量处理算成模型生成。下一条输入由 runMaintenance 同步认领真正 idle 并等待，兜底 assemble 门控保留原生输入身份/顺序/目标；等待不占 session task 队列或剧情锁，取消不伪造唤醒消息。页面断开或脚本失败保留任务并阻止旧变量进入新轮次。实际开场白既有旧 turn 0，也有 greeting 来源标记的 turn 1（无模型 finish chunk），两者均纳入测试。完成数据与任务回执同写 helper.json；闭合楼层追加 MVU 写先 reopenFloor 保留原始回滚快照，WAL 恢复成功后才确认完成。

rc.2 的公开 SessionEventSource 将流式回复结算发布为 `settle-assistant`，其 `entry` 可缺省，不带 `entries`。实时追加只处理 type=event 的持久记录；结算读取单个持久 entry，临时流的分数 seq 不推进基线或消费游标。replace/prepend 仍不回放历史，最终接收通知仍等待对应 turn/end 的剧情收口回执。测试加载同包的真实事件源 ESM，并用真实 AgentLoop 与工厂 LLM 流验证无人提交 MVU 时回复仍正常 completed/idle、下一条输入保留且提交后才生成。

2026-09-14 在实际 Windows/Node 24/rc.2 安装环境完成启动与页面冒烟：先取消旧代码卡住的生成，重建并重启宿主，刷新后正文保留、会话恢复空闲、卡面不再显示 `change.entries is not iterable`，消息选项正常出现。没有发送真实模型请求；新回复的自动 completed/idle 与待处理变量门控由上述真实 Loop 和工厂流测试覆盖。全量 127 个测试文件、1576 项测试通过，打包白名单检查通过。

2026-09-06 的真实浏览器双沙箱工厂验证：异步模块就绪后初始化 7，经 INITIALIZED 钩子变 10；后续 stop 工厂输入依次得到 15、20，下一次命令到 25 经结束钩子限制回 20，监听读取的当前消息位置为 1/2/3。随后在实际 Windows/Node 24/dsh 0.1.2-rc.1 的独立工厂 DSH_HOME 启动新构建，UI 开启原生 MVU；真实 turn 1 开场白完成初始化，磁盘 pending 为空、完成回执一条、WAL committed=true；原有卡面按钮继续保存 count=3，未调用模型。此验证覆盖初始化和普通变量衔接；正常模型 stop 链路另由真实 AgentLoop/Session 与手写流适配器集成测试验证，未调用真实模型。

本次原生 MVU 工厂整页重载后仍显示 count=3 且没有重复初始化；验收页、浏览器工厂服务与真实宿主进程均已关闭。


### 0.1.2-rc.1 脚本选项输入核对

已核对安装包 `@deepseek-ai/dsh-client-ui-conversation` 0.1.2-rc.1 的公开 `IConversation.input.for(actx)` / `SessionInput.setDraft` 与 `InputState` 类型。脚本选项的可信点击处理经 `sessions.scope(sessionId)` 获取本会话输入面；限制当前会话、plain 阶段、无引用，保留原草稿。此前 AI 代答采用剪贴板仍保持原行为，不能据此推断宿主完全没有可写草稿 API。

### 2026-09-19：rc.2 角色、真实模型与恢复验收

Windows / Node 24.18.0 / dsh 0.1.5-rc.2，使用独立临时 DSH_HOME、手写角色与工作区、最终构建产物及官方 browse 目录选择器 overlay。真实 Edge 页面验证角色新建/保存、按标签与作者搜索、角色多行输入框的可访问标签。无内嵌书 JSON 卡也展示兼容预检；已知未实现接口与父窗口访问被正确列出，取消后列表不增加角色，再次选择同文件并确认后保存成功。预检未执行卡内脚本。

经用户指定使用本机默认模型，实际路由为 deepseek-official / deepseek-flash，页面显示 DeepSeek-V41-Flash / High。仅发送手写验收剧情：第一轮正确读出角色口令，第二轮通过原生 PTC 调用记忆写入并正常结束；真实剧情 memory 文件包含预期事实，楼层 WAL committed=true。全量自动化测试仍不调用真实模型。仅让临时宿主读取既有凭据存储，没有将密钥或用户剧情复制进项目、测试或备份。

停止临时宿主后，编译后的 backup CLI 完成 create → verify → restore：32 文件、42 目录、233731 字节，3 处可重装依赖路径在清单中明确排除，无结构/引用问题。恢复到新 DSH_HOME，重新挂载当前插件开发依赖并由宿主重建依赖后启动；页面读回相同角色绑定、开场白、两轮消息和工具确认，继续发送第三次模型请求正常回复「蓝色工具箱。」并恢复空闲。此演练覆盖实际宿主持久日志的恢复与续聊，但 verify 命令本身只校验其字节，不宣称完整解析所有宿主历史格式。

本次验证覆盖上述基础链路，不代表任意第三方卡、所有 MVU 行为或旧历史迁移都已验收；同类项目比较和检查结果见 [项目审查记录](PROJECT_REVIEW_2026-09-19.md)。

### 2026-09-19：依赖替换后的 Markdown 展示验收

在上述独立恢复目录使用 Windows / Node 24.18.0 / dsh 0.1.5-rc.2 和最新构建启动宿主。真实 Edge 页面导入手写 EJS 开场白卡，兼容报告正确识别模板；选择卡并开始对话后，加粗、双/三下划线、保留单下划线、emoji、表格和删除线正常展示，两个 iframe 均为 `sandbox="allow-scripts"`。本次没有发送新模型请求。

实际截图发现无自定义配色的卡面在深色主题下文字过暗：修复 iframe 继承宿主 color-scheme，并在可信文档头声明 light/dark 支持，不强制覆盖卡片文字或背景。修复后深色白字、浅色黑字均清晰；整页重载仍正常，测试外观恢复为跟随系统。切回先前已完成剧情，原角色、开场白、三轮回复与工具确认仍可读。验收页和临时宿主均已关闭。

旧未完成模板或跨轮回调闭包的升级拒绝由真实文件系统与 worker 集成测试覆盖；此 UI 冒烟不将其宣称为任意旧日志可自动迁移。

### 2026-09-19：关于页与更新检查

开发构建会让网页拿到新界面，但运行中的 Node 宿主不会同步重新加载新增服务方法。实际旧进程复现：角色目录正常，`tavern/getPluginAbout` 尚未注册；Web Connection 对缺失路由返回 HTTP 404，客户端包装为 `gateway/internal`。关于页只对本接口的固定 404 及明确的方法/描述符缺失给出完整重启提示，不把断网、磁盘错误或其它路由 404 误判为此问题。恢复需停止原 dsh 进程、重新启动后刷新网页，单独刷新或重试不能重新注册后台方法。

核对已安装的 dsh 0.1.5-rc.2：`dsh-host-plugin-inventory` 只提供 `list()`，没有版本检查或安装更新 RPC；普通设置 section 也没有公开的插件页跳转接口。正式安装方式仍是 `dsh plugin --profile <name> add <package>`。因此关于页只按需读取 GitHub 正式发布与该标签的 package.json、核对实际宿主版本，再提供发布说明及固定标签命令；不执行 shell，不触发安装或重启。桌面内部更新桥和 Cordis 配置重启不作为替代接口。

在独立临时 DSH_HOME、Windows / Node 24.18.0 / 实际 rc.2 宿主完成 Edge 验收：Tavern 的第八个页签「关于」可打开，项目链接为 `https://github.com/Amakurai/dsh-liketavern`；实际读取插件 0.2.5、宿主 0.1.5-rc.2，并正确识别源码开发挂载。点击「检查更新」显示禁用的检查中状态，随后从真实 GitHub 返回 v0.2.5，提示版本号一致，发布说明定位到对应标签；没有安装操作或模型调用。未来新版本、宿主不兼容、断网、超时和复制失败由手写响应与真实 React 测试覆盖。

宿主版本从本次 Node 主入口的真实路径定位，并核对最近包的名称、bin.dsh 入口和版本；不将插件旁的开发依赖当作运行宿主。无法识别的嵌入式启动仍展示插件信息，但明确说明无法判断兼容性，不生成更新命令。修正后重启临时宿主再次验证版本与真实更新检查均正常，验收页面和临时宿主已关闭。

最终构建、140 个文件 / 1982 项测试（Windows 跳过 1 项 POSIX 用例）与 425 文件发布白名单检查通过。另一运行中的宿主持有 Windows 原生动态库，仓库原位 `npm ci` 遇到占用；随后以 `npm install` 恢复完整依赖，在独立空目录使用相同 package.json、锁文件及 .npmrc 完成干净 `npm ci`，审计为 0 项已知漏洞。没有停止用户正在运行的宿主；依赖弃用边界仍见依赖安全记录。

### 2026-09-19：官方 MVU beta 入口与脚本跨窗口诊断

官方 `MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js` 纯导入与无版本入口采用同一个原生 MVU 适配，避免漏识别后加载要求 Vue 和父窗口全局对象的原版框架。只扩大到 `@beta`，未知版本、额外代码或相似地址仍保留原文。运行状态对浏览器明确拒绝的跨窗口读取显示「需要适配」，保留原始错误与 MVU 的失败阻断。

使用手写工厂快照和本次编译的 srcDoc，在独立本地测试页的真实 Edge 中验证：`sandbox="allow-scripts"` 下，关闭外部脚本和网络的官方 beta 入口成功返回就绪；读取 `parent.document` 与父窗口自定义加载标记均继续报跨域错误，并被诊断器正确识别。本次没有启动新宿主或调用模型，没有改动真实卡片和剧情；该冒烟不代表依赖酒馆主页面的状态栏、正文改写脚本已经迁移。

本次构建、147 文件 / 2090 项测试通过（Windows 跳过 1 项 POSIX 用例），`npm pack --dry-run` 和 429 文件发布白名单检查通过。原位 `npm ci` 遇到运行中进程占用原生动态库，使用锁文件恢复依赖后，在独立空目录完成相同 manifest、锁文件和 `.npmrc` 的干净安装；package.json 与锁文件未改变。测试页和测试服务器已关闭；安装验证临时目录的清理被执行策略拒绝，保留于系统临时目录，不进入仓库或发布包。

### 2026-09-19：消息卡面漏识别与加载恢复

修复孤立反引号、行内波浪号误开启代码状态，以及跨段反引号吞掉 HTML 围栏的问题；代码标记一次索引，真实代码跨度、未闭合围栏、引用与列表代码继续保持不可执行。核对实际安装的 rc.2 conversation / renderer / chat 包后，仍沿用公开 useSessions、assistant-step 与 finalNode.seq 契约。角色绑定读取失败保留同会话卡面，首次失败展示重试；切换会话不复用旧绑定。展示请求失败保留原文并允许手动重试，交互卡开关变化重新加载展示。

普通正文和已提交模板片段均返回有界、去重的展示正则失败诊断，成功规则继续生效。真实文件系统与模拟宿主测试验证重复读取不改历史或模板状态；真实 React 测试覆盖拒绝、错误响应、超时、重试、开关变化、跨会话隔离和诊断文本转义。

最终构建产物在独立本地 Edge 测试页验证三种工厂内容：孤立反引号、行内波浪号及 HTML 围栏后的卡片均出现，按钮可点击、整页重载仍正常，三个 iframe 均仅为 `sandbox="allow-scripts"`，读取父窗口继续被拒绝。此页使用真实隔离 worker、展示拆分与卡面 srcDoc；诊断外壳为测试页面，实际插件组件由 React 测试覆盖。本次未启动新宿主、调用模型或修改真实剧情，也未取得截图中角色的原始回复和展示规则，不能据此确认其唯一根因。测试页和服务器已关闭。

最终全量 149 个测试文件通过，2117 项通过、Windows 跳过 1 项 POSIX 用例；构建、`npm pack --dry-run --ignore-scripts`（此前已完成构建）与 431 文件发布白名单检查通过。本轮未更改依赖。
