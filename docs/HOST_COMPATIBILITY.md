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
10. 卡内变量兼容参考 [Tavern Helper 变量接口定义](https://github.com/N0VI028/JS-Slash-Runner/blob/main/%40types/function/variables.d.ts)，目前提供 get / replace / insertOrAssign / insert 四项。各 scope 在当前 iframe 内分表，`character` / `global` 也不读写宿主角色资产或全局数据。备份大小上限 1 MiB；恢复由用户在宿主表单中粘贴并校验后创建新 iframe，保留 sandbox/CSP/消息来源校验。原生页面刷新会清空内存变量；不提供自动持久化和完整 Tavern Helper API。
11. 备份恢复必须创建新 iframe 文档。直接 `document.write` 重跑第三方页面会留下顶层词法绑定并触发 const 重声明；跨 opaque-origin 刷新也不能依赖窗口名传递数据。文档内的常规 rewrite 仅用于加载卡片内容，桥只装一层原生包装，重装前清理旧观察器与定时器。
12. 手机设置布局：`dsh-client-ui-settings-general` 的设置 dialog 在 390px 视口中宽 342px，仍保留 188px 导航及正文两侧 48px 内边距，使 Tavern 正文只剩约 98px（含滚动条差异）。`styles.ts` 在视口不超过 560px 且 dialog 含 `.dsh-tavern-panel` 时，把原导航按钮排成横向滚动顶栏；通过直属 `nav` 与相邻正文结构限定外壳，未替换宿主节点或改其状态。其它设置页/桌面恢复宿主样式；升级时核对 SettingsPanel 结构。主会话侧栏由 `dsh-client-ui-layout` 在低于 1024px 时自动折为 56px，手动展开由用户控制，插件不调用 toggle 强制修改桌面宽度。手机弹窗使用动态视口高度和 flex 正文滚动分配，第三方 iframe 内部是否响应式仍由卡片自身实现决定。

13. 重启后浏览旧会话可能只有持久日志，`ctx.sessions.get` 只返回已在线的 Session，不能据此判断“没有开场白”。展示与空白判定优先在线日志，否则使用 `ctx.sessionPersistence.inspect` 的不可变检查结果；不能用会修复并写盘的 `load`，也不能为展示调用 agents.resume。已验证冷会话 EJS 开场白可读且不落模板变量。
14. rc.1 的输入和 assistant Message 都有稳定 `id`。按消息模板变量使用该 id，不能由正文或事件 seq 推断；编辑后的新 Message.id 即使沿用 seq 也不能复用旧快照。历史投影仅使用 deriveMessages 可见消息，并按 inbox id 对待入日志输入去重。真实分支复制继承消息 id，变量和 sticky 仍随 story 文件独立推进。

升级 dsh 的检查清单：

- 模板回复处理依赖 `assistant/chunk` 的唯一末尾 `finish.reason.kind=stop`、`assistant/message` 的 seq/turn/step 与 `turn/end.reason.kind=completed`。必须在当前楼层关闭前保存展示快照；client 的 finalNode.seq 传给只读渲染接口。升级时核对这些真实字段和 turn 状态，不能在刷新回调中执行持久脚本。
- `package.json` 三处版本同步：`peerDependencies`、`overrides`、`devDependencies`（全部精确版本，不带 `^`）。
- 逐条复查上面注记在新宿主上是否仍成立，失效的改掉并从本节删除。
- 对照官方文档的 breaking changes：slot、profile/bundle、patch 层顺序、system-prompt 瀑布、agent 事件、session 读取 API、client seed 模块表。
- `npm install` → `npm run build` → `npm test` → `npm pack --dry-run`，再 `npm run dev` 实机冒烟（peer 缺失只会在宿主 boot 时暴露）。
- 扫描宿主包的非可选 peer：缺失的宿主内部包补进 devDependencies；cordis / schemastery 等跟随宿主版本（0.1.2 起宿主大量依赖改写为 peer，`legacy-peer-deps` 不会自动装）。
- 在 `CHANGELOG.md` 记一行适配的 dsh 版本。


另见宿主源码：`dsh-agent-loop` 在 buildRequest 中深度冻结 GenerateOptions；`dsh-llm` 的 llm/stream waterfall 可观察请求，但 next() 不接受替换消息。本插件只读观察，不在中间件另起调用。
