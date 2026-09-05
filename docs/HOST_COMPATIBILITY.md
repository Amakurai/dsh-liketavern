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

升级 dsh 的检查清单：

- `package.json` 三处版本同步：`peerDependencies`、`overrides`、`devDependencies`（全部精确版本，不带 `^`）。
- 逐条复查上面注记在新宿主上是否仍成立，失效的改掉并从本节删除。
- 对照官方文档的 breaking changes：slot、profile/bundle、patch 层顺序、system-prompt 瀑布、agent 事件、session 读取 API、client seed 模块表。
- `npm install` → `npm run build` → `npm test` → `npm pack --dry-run`，再 `npm run dev` 实机冒烟（peer 缺失只会在宿主 boot 时暴露）。
- 扫描宿主包的非可选 peer：缺失的宿主内部包补进 devDependencies；cordis / schemastery 等跟随宿主版本（0.1.2 起宿主大量依赖改写为 peer，`legacy-peer-deps` 不会自动装）。
- 在 `CHANGELOG.md` 记一行适配的 dsh 版本。


另见宿主源码：`dsh-agent-loop` 在 buildRequest 中深度冻结 GenerateOptions；`dsh-llm` 的 llm/stream waterfall 可观察请求，但 next() 不接受替换消息。本插件只读观察，不在中间件另起调用。
