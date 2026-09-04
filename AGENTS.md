# AGENTS.md

给要改这个仓库的人（包括编码代理）看的约定。读完再动手。用户向说明见 [README.md](./README.md)。

## 这是什么

dsh-liketavern 是 DeepSeek Harness（dsh）插件，把 `dsh web` 做成 SillyTavern 式角色扮演前端：角色卡（V1/V2/V3，PNG/JSON）、提示词预设、世界书、人设、正则、BM25 长期记忆、世界状态变化层、可回滚楼层操作，全部建在 dsh 的 agent 运行时上，不另起发信通道。

和 SillyTavern 最不一样的四件事，改代码时请按这个想：

1. **资产文件化**：卡/世界书/预设落成工作区文件，agent 按需按条读，不整本塞进 prompt 或灌进工具结果。
2. **多步思考**：一轮可走多步 agent 循环；默认直接扮演，不例行调工具。
3. **楼层事务**：某层触发的写入（记忆/世界状态/定时器）走 WAL（楼层号+序号）可逆序回滚。例外：idle 期 `runMaintenance` 的记忆压缩（`floor=null` 不记 WAL）是无损整理，回退不撤。
4. **不复制 ST 的一次性输入**：提示词走 dsh system-prompt 瀑布（稳定段 + runtime context），不在前端拼包直发，绝不用 `complete` 段盖掉工具前缀。

实测环境：dsh `0.1.2-rc.1`（`@deepseek-ai/*` 同版本）、Node 24、Windows（CI 在 ubuntu）。本版特有宿主行为见「宿主版本注记与升级」。

- 查平台行为先看官方文档 <https://deepseek-harness.github.io/deepseek-harness/>；宿主机制（slot、profile、patch、typert、system-prompt 瀑布等）以文档和宿主源码为准，不凭记忆猜。
- 查宿主源码读 `node_modules/@deepseek-ai/*/` 的 `lib/` 与 `.d.ts`（本体与 peer 包版本可能不同，先看各包 `package.json`）。
- 运行期角色卡、记忆、会话绑定在 `$DSH_HOME/dsh-tavern/`，不在本仓库。真实卡不进 git，测试用手写工厂数据。

## 技术栈与三面运行

- TypeScript ESM（`module: NodeNext`），strict + `noUncheckedIndexedAccess`。
- 宿主是 dsh（cordis 容器），分三面：
  - **host**（`src/index.ts`）：设置命名空间 `dsh-tavern`、数据目录初始化、agent 预设安装、`TavernService`、typert remote 注册、听 `session/event` 维护楼层 WAL 与每 turn/step 缓存。
  - **agent**（`src/agent.ts`）：`system-prompt/assemble` 写稳定段 `tavern:standing` 与 runtime context `tavern:turn`；`agent/pre-step` 记 step；`agent/request` 合采样并把 thinking 映射成 `reasoningEffort`；注册 7 个模型工具；idle 时 `runMaintenance` 压缩记忆。
  - **client**（`src/client/`）：浏览器 React UI，五块 slot（设置 `settings.section`、助手操作条、会话头芯片、新会话英雄区 `conversation.input.dock`、助手排版 `conversation.chat.node`）。remote 经 `ctx.remote.$mount(TYPERT_REMOTE)` 挂，调用用 `ctx.get('remote.tavern')`。图片走 owner props 的 `renderMessageImages({ images, align })`（0.1.2 起 `loadImage` 不再传给 keyed 渲染器）；`fileMentions` 是 owner 函数，用 turn-tail owner 解析后再传给 MarkdownText；0.1.2 起 MarkdownText 的 `labels` 为必填，经 `useMarkdownLabels()` 取本插件字典。
- **remote 契约**（`src/remote.ts`）：方法返回裸业务值、失败抛错，`{ ok, value|error }` 信封由 gateway 生成。结果类型的单一来源是同文件的 `TavernMethodResults`（方法名 → 裸业务结果类型）：`src/node/service.ts` 每个方法的返回注解与 `src/client/types.ts` 的 `TavernRemote` 镜像都索引这张表，改任何一面的返回形状，另一面立即编译报错。加删改一个方法必须三处同步：`src/remote.ts` 的 `METHODS` + `TavernMethodResults`、`src/node/service.ts` 实现、`src/client/types.ts` 的 `TavernRemote` 镜像——漏改就编译不过，这是设计好的保险。
- 运行时依赖只有 `zod`；`@deepseek-ai/*` 走 peerDependency 由宿主提供；开发依赖用公开 npm 精确版本。禁止 `file:`、本机绝对路径、junction/符号链接依赖。bundle 里平台模块一律 external。
- 设置用 schemastery（`src/node/config.ts`），命名空间 `dsh-tavern`，`applies: 'live'`。宿主通用设置页也能看到/改这些键（宿主行为，rc.2 起、0.1.2 仍无命名空间白名单），插件面板仍是主入口，不要为此改面板。

## 提示词通道与 agent 循环

live 路径不把整包 ST 预设塞进 system。`assemblePrompt` 按 Prompt Manager 算全量序列（仅预览用），再拆成两条 dsh 通道：

| 通道 | dsh 落点 | 内容与稳定性 |
| --- | --- | --- |
| standing | system 段 `tavern:standing`（order 210，工具说明 100–199 之后） | `BOUND_DISCIPLINE` + 角色定义 + 预设骨架 + 常驻世界书 + 静态深度注入。按会话 × 生成场景钉死字节（`STANDING_PIN_VERSION` + generationType + 卡/预设/人设指纹 + 资产修订号）。**改纪律或段布局必须递增版本**，否则旧钉死挡住新文案。资产修订号经 `TavernState` 写方法 bump（`standingRevTags`），绕开它手改文件不被捕获。 |
| turn | runtime context `tavern:turn` | 固定 `TURN_PLAYBOOK`（不随 step 变）+ 关键词世界书/记忆/变化层/AN/本轮宏。dsh 追加成 user 快照覆盖同名旧快照，宿主按字节去重——同轮快照不变则后续步骤不再追加（多步零开销）。 |
| messages | 仅「预览提示词」 | 完整 ST 序列（含 @D 真实插历史位置）。live 请求插不进会话日志中间，排查以预览为准。 |

要点：

- 时钟在 standing 冻结。残留 `{{…}}` 写入 dsh 段前要 `neutralizeDshMustache`。未绑卡时不要删 `tavern:standing` 段，换成 `UNBOUND_STANDING` 短文案，避免段布局抖动打穿 KV。
- **turn 层预算**（`core/turnBudget.ts`）：runtime context 快照对新请求永远是未缓存前缀，大体量内容 = 每轮全价重付。世界书用固定 `tokenBudget`（默认 8192 绝对上限；百分比基数 clamp 到 128K），只计搭快照通道的条目；落 standing 的常驻条目（constant 且无本轮宏，`isStandingSafeEntry`）豁免计费与概率掷骰（掷骰每会话冻结一次，fork 重掷会打穿 system 前缀缓存）。被裁条目进 `truncated`、快照尾部附 uid 清单（封顶 8 条），模型按条 `tavern_lore_read` 补读——硬顶是分页不是丢信息。世界书/记忆段落带来源标签（standing `【世界书·常驻】`、turn `【世界书·本轮触发】`、记忆 `【检索记忆】`；AN 走 `wiText` 不加）。变化层按 `WORLD_DELTA_TURN_BUDGET`（1500）从最新往旧装载，更旧的丢给 `tavern_lore_read(source=delta)`；记忆（1200）与 journal（800）各自有顶。观测日志：`[turn:tail]`、`[standing:pin]`。
- **多步循环**：世界书/记忆检索每 turn 只评估一次（同轮复用 `wiCache`；`lastCharMessage` 与 `journalText` 随 `wiCache` 同轮冻结，否则按字节去重失效）。每步仍跑 `runTavernPipeline` 重放本轮快照。工具写入不重评世界书（避免 sticky/cooldown 同轮连 tick），写成功 `agent.inject` 一条 `【Tavern 同轮写入】`（`form: 'notice'`）。步骤收口通知（`formatTurnStepNotice`）只能在工具执行时注入（`node/tools.ts` 的 `maybeInjectStepNotice`），**不要在 `agent/pre-step` 里 inject**——晚一步被认领，且 turn 结束判定会把未消费的 nextStep 当续步理由，强拉出孤儿通知。
- 合成 user 文本（runtime context 快照、同轮写入确认、步骤收口通知）走 `isSyntheticUserText`：不当 `{{lastusermessage}}`，不扫世界书，不计入正则 depth。
- 采样 / thinking：`agent/request` 透传 `temperature` / `maxTokens` / `stop`，按模型公布的 reasoning 档写 `reasoningEffort`（挑选逻辑见 `core/callConfig.ts`；enabled 档保留会话已选非 off 档，要长思考引导用户选 high/max）。只发送适配器公布的 id；部署把 `llm-deepseek.thinking` 锁成 `disabled` 时插件无法强开。

## 模型工具（7 个）

注册在 `src/node/tools.ts`。默认直接扮演；只在缺设定、长上下文遗忘、或要把本轮已确定事实落盘时调用。

| 工具 | 用途 |
| --- | --- |
| `tavern_memory_search` | BM25 检索。runtime context 里的记忆不够再用。 |
| `tavern_memory_write` / `update` | 只记事实与关系/状态变化。去重；超容量标记 `pendingMemoryCompress`，turn 结束后 `runMaintenance` 异步压缩（不记 WAL）。写成功 inject 同轮确认。 |
| `tavern_lore_read` | 先目录再取条。无参 = uid/键/摘要目录；`uid` 或 `query` 取正文（有 token 预算）。含全局/角色/会话/变化层，disabled 条目仍可读。禁止整本 JSON 倾倒。 |
| `tavern_worldstate_update` | add/update/invalidate。写成功同样 inject。 |
| `tavern_asset_list` | 工作区文件 + 绑定预设条目目录。 |
| `tavern_asset_read` | `path` 读工作区文本（`journal.md`、`memory/*.md`、`assets/*.json` 等）；`preset: list` 列预设，`preset: identifier` 取正文（含未启用）。拒绝绝对路径、`..`、WAL、图片。 |

工作区路径必须经 `WorkspaceFs`（越界抛错）+ `resolveReadableAssetPath`（可读白名单）。不要加通用任意文件读取。

## 构建与测试

```bash
npm install        # dsh 开发依赖从公开 npm 安装
npm run build      # tsc -p tsconfig.json（产出 lib/ 含 .d.ts）+ node scripts/build-client.mjs
npm test           # vitest run
npm run dev        # dsh web --patch ./cordis.dev.yml（需先建 junction，见 README）
```

构建两段式：`tsc` 把 `src/` 编到 `lib/`，`scripts/build-client.mjs` 再用 esbuild 打成单文件 CJS bundle `lib/client.js`（宿主提供的 react、cordis、dsh-client-* 保持 external）。

`lib/` 是交付物，**刻意入库**，`.gitignore` 不要忽略它；改代码后必须重新 `npm run build`。CI（ubuntu + Node 24）跑 `npm ci` → build → test，然后 `git diff --exit-code lib/` 拦未重建产物、`git status --porcelain -- lib/` 拦未跟踪新产物，最后解析 `npm pack --dry-run --json` 断言文件白名单（必含 `lib/index.js` 等，不得含 `src/`/`test/`/`node_modules/`）。行尾靠 `.gitattributes`（`* text=auto`）。

角色卡、运行期 JSON、图片、会话、记忆和本机 `file:` 依赖不能进入 Git 或 npm 包。

## 代码结构

```
src/
├── core/    纯函数层（无 I/O，全部可单测）
│            types / assemble / worldbook / regex / macros / tokenize /
│            memoryRetrieval / turnBudget / loreQuery / assetRead / callConfig /
│            standingPin / dshPrompt / persona / greetingLog / tavernMode /
│            displaySanitize / bm25 / binding / siblings / cardFrame
├── state/   存储层（文件 I/O，落 $DSH_HOME/dsh-tavern/）
│            card / lorebook / presetStore / memory / worlddelta / siblings /
│            workspace / workspaceFs / wal
├── node/    host 运行时
│            config / paths / state / service / pipeline / floors / greetingSeed /
│            tavernSession / tools / impersonate（AI 代答：带外一次性调用，不开 turn
│            不记 WAL）/ memoryMaintenance / bindings / presetInstall
├── client/  浏览器 UI
│            index / mode / chip / hero / seatWatch / seatChip / speech / assistant /
│            actions / openChild / util / styles / i18n（useT/t 语言运行时）/
│            locales（聚合 client/locales/<module>.ts 字典，zh 为键全集源）/
│            types（TavernRemote 契约镜像，改 remote/service 必须同步）
│            └── panel/  设置子面板（characters/presets/lorebooks/lorebookEditor/
│                personas/regex/memory/settings）
├── index.ts   host 入口
├── agent.ts   agent 面入口
└── remote.ts  typert 契约
```

对应测试在 `test/`：core/state 纯逻辑为主，加上 binding、cardFrame、workspace、floorsForkOptions、greetingSeed、stateRuntime、openChild、siblings、presetInstall、i18n 等。host 事件与 client UI 不测。

## 代码风格

- 注释和文档用中文，标识符用英文。每个源文件用块注释说明职责；跨层约定（信封、定时语义、WAL、封面桥、合成 user 文本）写在使用点。
- ESM 显式扩展名：相对导入一律写 `.js`（NodeNext），包括 client TSX。
- strict + `noUncheckedIndexedAccess`；`exactOptionalPropertyTypes: false`。数组/索引访问要处理 `undefined`。
- cordis 插件：导出 `name` / `inject` / `apply(ctx)`；需手动清理的用 `ctx.effect()`。
- 分层：`core/` 不 import `node:fs`；I/O 只在 `state/`；编排只在 `node/`。client 不直连平台内部 API，只走 typert remote。
- client 不能 `inject: ['remote.tavern']`（`$mount` 在 apply 内自装，声明会死锁）。用 `ctx.get('remote.tavern')`，不要写 `ctx.remote.tavern`。
- UI 对齐 dsh 原生：交互组件走 `@deepseek-ai/dsh-client-ui-primitives`（封装见 `src/client/util.tsx`）；禁止原生 `<select>` 与 `window.confirm`（确认用 `ConfirmDialog`）；样式只进 `src/client/styles.ts`；颜色只用真实存在的 `--dsw-*` 令牌和文件顶部定义的 `--tavern-accent-*` 变量，不发明新色值；动效用 `--ds-ease-in-out` 加 0.1/0.2/0.3s，遵守 `prefers-reduced-motion`；页签用分段控件 `Tabs`；设置行用 `SettingsRow`、一组表单的保存按钮放 `SaveBar`；瞬时反馈 `useToast`、加载 `Skeleton`、头像 `Avatar`、可点卡片 `clickableProps`。
- 展示名永远用 `card.name`；不要把工作区文件夹 `cardId`（净化名 + 8 位 hash）当角色名。头像走 `getAvatar({ cardId })` 的 PNG dataURL。
- 界面文案一律经 `i18n.ts` 的 `useT()` 取字典（插值用 `{name}` 占位符），不写死任何一种语言。字典按模块分片在 `client/locales/<module>.ts`（zh 是键全集源，en 同键齐全，`test/i18n.test.ts` 校验 parity）。slot label 也走这套字典。

## 测试策略

- `npm test`（vitest run）。改 `core/`、`state/` 必须同步更新或新增对应测试。
- 测试直接 `import ... from '../src/<层>/<模块>.js'`，不必先构建。
- 每个测试文件开头用中文块注释列覆盖点。用手写工厂构造全字段默认值（如 `makeEntry`）。枚举和默认值从 `src/core/types.ts` 导入，不要复制字面量。
- 覆盖重点是确定性纯逻辑：世界书触发全矩阵、宏、正则、BM25、预设/卡/世界书归一化、WAL 回滚、工作区、`resolveStaleBinding`、交互卡 CSP/ST stub、standing 钉死、lore 按条筛选、资产路径消毒、reasoningEffort 挑选、合成 user 文本。
- 不要把真实角色卡、世界书导出或会话绑定放进 `test/`。

## 平台限制（开发者视角；用户向简版见 README）

1. 采样只透传 `temperature` / `maxTokens` / `stop` 和模型公布的 `reasoningEffort`；`top_p` 与 penalty 到不了模型，设置面板仅作记录。
2. 深度注入（@D / depth_prompt / 预设 in-chat）插不进会话日志中间：触发型（含本轮宏）并入 turn 快照尾部，静态的并入 standing（钉死）。预览才是完整 ST 序列（不含 live playbook）。
3. 会话日志不可删。重新生成/回退/编辑 = fork 前缀 + WAL 回滚 + 子会话续跑，成功后 UI 打开分支会话并用宿主 `ISessions` 的 `scope → sessionOf → rename` 写分支标题（旧宿主缺这条路径则跳过）。编辑 assistant 正文只换 seed 里的该条消息、不续跑。例外：续写（`continueFloor`）不改历史不 fork，直接 followup 合成指令。同一父会话 + 同一楼层 fork 出的分支互为兄弟：forkAt 记 `siblings.json`，操作条给 ‹ n/m › 导航（`getFloorSiblings`，读时过滤已删分支）。会话头另有宿主原生面包屑（`meta.parentSession` 世系，`conversation.session.header.lineage`，0.1.2 occupant 为 client-ui-subagent）：会话级世系，与楼层级 ‹ n/m › 互补，不要替换那个 slot。
4. 操作条 slot 只在 assistant 消息上，且宿主只对 finalized 消息挂 slot——被中断的楼层天然没有操作条，由 chat.node 侧补挂 `TavernInterruptedFloorActions`（`src/client/actions.tsx` 末尾；兄弟导航/重新生成/回退），这种楼层 messageId 不可用于定位，改为传 `turn`（`resolveFloorTurn`，`src/node/floors.ts`；`regenerate`/`rollbackToFloor`/`getFloorSiblings` 的 remote schema 均带可选 `turn`）。「编辑用户消息」/续写/代答都挂在 assistant 楼层。dsh 输入区没有插件可写 API，impersonate 结果只能复制到剪贴板。
5. 同一角色卡多会话并发写入会交错（工作区与 WAL 以卡为单位共享）。已知边界，不要去「修」。
6. 角色选择和开场白预览只在 agent 预设为 `tavern`（`src/client/mode.ts`）时显示。

## 常用改动 checklist

- **加/改 remote 方法**：三处同步——`src/remote.ts` 的 `METHODS`（schema/简介）与 `TavernMethodResults`（裸业务结果类型，契约单一来源）、`src/node/service.ts` 实现（返回注解写 `Promise<TavernMethodResults['<method>']>`）、`src/client/types.ts` 契约镜像（`TavernRemote` 索引同一张表，不手写结果形状）。结果形状以 service 实现为准；改形状后两面编译报错即同步点。返回裸业务值、失败抛错，信封由 gateway 生成。
- **加模型工具**：在 `src/node/tools.ts` 注册，描述里写清「默认直接扮演，只在缺设定/遗忘/落盘时调」的分寸；路径必须过 `WorkspaceFs` + `resolveReadableAssetPath`；写成功 `agent.inject` 同轮确认；同步更新本文「模型工具」表。
- **加设置项**：`src/node/config.ts`（schemastery，`applies: 'live'`）+ `src/client/panel/settings.tsx`（六个子组之一）+ slot label 进字典。默认值有跨层引用时放 `src/core/types.ts`。
- **加/改 UI**：样式只进 `src/client/styles.ts`；交互组件走 `dsh-client-ui-primitives`；文案进 `client/locales/` 字典。
- **改 standing 纪律文案或段布局**：递增 `STANDING_PIN_VERSION`（`src/core/standingPin.ts`）。
- **任何 `src/` 改动**：先 `npm run build` 再提交，CI 会拦过期产物。

## 宿主版本注记与升级（当前 dsh 0.1.2-rc.1）

以下行为绑定 0.1.2-rc.1，升级宿主时逐条复查（以官方文档和宿主源码为准）：

1. `Session.events` 数组属性已移除：读全量用 `snapshotEvents()`（下次追加前缓存复用，放心多次调），单条 `eventAt(seq)`，日志长度 `session.seq`。`header.seedLength` 移除：fork 继承前缀长度是 `session.inheritedEventCount`；`agents.create` 的 meta 写 `isSeeded: true` + 顶层 `inheritedEventCount`（与官方 `SessionStore.fork` 同形）。
2. 会话预设判定：`resolveSessionPreset` 帮手移除，官方路径是 `agentPreset` 会话投影；插件封装在 `sessionPresetId`（投影缺席时手动折叠 header + `agent-preset/selected` 兜底）。
3. client 侧：「新对话」动作从 `ctx.workspaces.startSession` 迁到 `ctx.uiWorkspace.startSession`（seatWatch 双路径兜底）；`dsh-client-runtime` 包删除，`dsh.client.inject` 不再需要（bundle 只 require seed 词：react 系 / cordis / ui-slots / ui-primitives）；`dsh-client-web-react` / `dsh-client-schema-form` / `dsh-client-ui-attachment` 均不在 seed。chat.node owner props 与 MarkdownText `labels` 变化见「技术栈与三面运行」client 条。界面语言 auto 档经 `ctx.locale.getSnapshot().active` + `subscribe` 跟随宿主（LocaleRuntime）。会话列表摘要 `SessionSummary` 顶层不再有 `agentPreset`，预设 id 只读 `projectionValues.agentPreset`（`src/client/mode.ts`，读错位置会让全部会话面 UI 静默）；`SessionSnapshot` 移除 `composerPhase`，英雄区空会话判定用 `blank && !promptAttempted`。
4. 杂项迁移：`settingsNamespace()` 帮手移除（`settings.register` 直接吃字面量）；`JsonValue` 从 `dsh-session/types` 挪到 `@deepseek-ai/dsh-util-values`。dsh 把大量运行时依赖改写成了 peer（`dsh-jobs` / `dsh-session-persistence` 等基础包不再自动安装），本仓库 `legacy-peer-deps` 下这些宿主内部包必须显式列进 devDependencies，且 cordis / schemastery 要跟随宿主版本（当前 4.0.2 / 3.18.2）。
5. web 设置 RPC 无命名空间白名单（rc.2 起，0.1.2 仍成立），宿主通用设置页也能看到/改 `dsh-tavern` 的键——宿主行为，不要为此改插件面板。
6. 会话头宿主原生面包屑（`conversation.session.header.lineage`）与楼层级 ‹ n/m › 互补，不要替换那个 slot。

升级 dsh 的检查清单：

- `package.json` 三处版本同步：`peerDependencies`、`overrides`、`devDependencies`（全部精确版本，不带 `^`）。
- 逐条复查上面注记在新宿主上是否仍成立，失效的改掉并从本节删除。
- 对照官方文档的 breaking changes：slot、profile/bundle、patch 层顺序、system-prompt 瀑布、agent 事件、session 读取 API、client seed 模块表。
- `npm install` → `npm run build` → `npm test` → `npm pack --dry-run`，再 `npm run dev` 实机冒烟（peer 缺失只会在宿主 boot 时暴露）。
- 扫描宿主包的非可选 peer：缺失的宿主内部包补进 devDependencies；cordis / schemastery 等跟随宿主版本（0.1.2 起宿主大量依赖改写为 peer，`legacy-peer-deps` 不会自动装）。
- 在 `CHANGELOG.md` 记一行适配的 dsh 版本。

## 动手前必知（近期踩过，不要回退）

1. **`cardId` 不是显示名**。`newCardId` 是净化名 + `sha1(name+随机)` 前 8 位，同名片互不覆盖，删卡再导入是新 ID。`TavernState.loadBinding` 必须走 `resolveStaleBinding`（按 `cardName`，或库里只剩一张卡时接回）。`deleteCharacter` 必须 `clearBindingsForCard`。回收失败则删绑定文件，视为未绑定。
2. **导入角色卡**先 `inspectCharacter`（不落盘）。有内嵌世界书时用 DSH `Modal` 询问。`importCharacter({ importWorldBook })` 为 false 时不写 `assets/character-book.json`，且 `card.json.characterBook = null`。
3. **卡内嵌世界书**可从 `data.character_book`、顶层、`extensions` 多处解析。设置「世界书 → 角色卡内嵌」和芯片主世界书空选项都要能看到。管线读卡内书，不要只扫 `library/lorebooks`。`tavern_lore_read` 必须走 `loadBoundLoreEntries`（全局+角色+会话+变化层），不要只 dump `character-book.json`。
4. **封面 HTML**（output/render 正则把标记换成整页 HTML）：`SpeechBubble` 用 `sandbox="allow-scripts"` iframe。`regex_scripts` 常在 V3 `extensions` 里，展示向规则默认启用（`disabled: true` 才关）。抽 HTML 见 `extractRenderedHtml`（含 text 代码围栏）。
5. **封面外网图默认放行**。CSP 在 `src/core/cardFrame.ts`：`img-src` / `font-src` 允许 https/http/data；`connect-src` 默认 `'none'`。`cardNetworkWhitelist` 放宽脚本 fetch 与外部脚本（`*` = 全部放行）。不要改回「白名单为空则禁止一切图片」。
6. **交互卡里切 swipe 的按钮必须真的能点**。注入 ST / JS-Slash-Runner stub，经 `postMessage`（`source: 'dsh-tavern-card'`）只允许 `swipeGreeting`。禁止 `allow-same-origin`，禁止通用主窗口桥。
7. **非会话写入不记 WAL**。导入/设置改文件时 `WorkspaceFs` 的 floor 为 `null`。但每卡共享句柄 `workspace(cardId).fs` 的 floor 在 turn/start～turn/end 之间**非 null**：面板/服务层写方法（state.ts 的 saveJournal/saveCharacter/saveCharacterLorebook/deleteCharacterLorebook/saveChatLorebook 与导入建索引）一律走 `plainFs`（floor 恒 null），否则生成进行中的用户编辑会被误记进当前楼层 WAL、回退时静默改回旧值；turn 流程内的工具写路径才走共享句柄。不要复活名为 `non-floor` 的 WAL 单元。
8. **新对话不自动选卡**。`settings.defaults` 只在用户点选角色时套用。`hero.tsx` 不得按 `defaults.cardId` 自动绑定，也不得在已有绑定上自动 `ensureGreeting`；空白 Tavern 会话若仍带着上次留下的绑定文件，英雄区应清掉。楼层 fork 必须走 `agents.create`（id 前缀 `session-`）+ `workspace.attachSession`，禁止 `ctx.sessions.fork` 或 `tavern-` 前缀。create 必须带父会话 `agentOptions`（provider/model，优先 `requestHeader`），否则子会话立刻 followup 时 `deployment:persona` 的 `{{model}}` 无值。开场白 swipe 把新 turn 放进 create 的 seed。客户端 `refresh` 列表后再 `open` 子会话（`openChild.ts`）。无会话 hero 上选「Tavern 模式」时宿主只暂存选择，`seatWatch.ts` 会代为 `workspaces.startSession()`——不要删这个补偿。
9. **`{{setvar}}` / `{{getvar}}` 是组装前预处理**，不是扔给模型。一次 `assemblePrompt` 共享 `Map` store；set 条目展开后变空并省略；后写覆盖先写。`{{lastusermessage}}` / `{{outlet}}` / 时钟进 `turnContext`，不要写进 `tavern:standing`。不落盘，不做 if/dice/STscript。预设内嵌 `regex_scripts` 随预设导入（`compilePresetRegexScripts`，跟脚本 `disabled` 走）；UI 开关直接改写预设文件的 `disabled`。常驻世界书（constant、无本轮宏）进 standing。
10. **不要把整包 ST 改成 `complete` 段。** standing 放在工具说明之后（order 210），工具前缀才能命中 DeepSeek KV。turn playbook / 本轮世界书/记忆只能进 `tavern:turn`。
11. **不要整本倾倒世界书，也不要在 step>1 跳过组装。** `tavern_lore_read` 先目录再 uid/query；step>1 仍组装，是为了长上下文下重放本轮快照。
12. **同轮写入确认与续写指令不可当用户台词。** `TURN_WRITE_ACK_PREFIX`（`【Tavern 同轮写入】`）、`CONTINUE_INSTRUCTION_PREFIX`（`【Tavern 续写】`）和 `TURN_STEP_NOTICE_PREFIX`（`【Tavern 步骤】`）必须继续被 `isSyntheticUserText` 过滤（含 pendingInputs 进 scanMessages 前）。不要为了「立刻进检索层」同轮重跑 `evaluateWorldInfo`。

## 安全

- 交互卡是第三方代码：`sandbox="allow-scripts"`（无 `allow-same-origin`）+ CSP（`default-src 'none'`，内联脚本/样式；默认允许 https 图片/字体，`connect-src` 默认 none）。封面按钮经 ST stub `postMessage` 只允许 `swipeGreeting`。改渲染路径时不得放宽 `allow-same-origin`，也不得拿掉 stub 只留「不支持」说明。
- 路径和文件名要消毒（`sessionFile`、`resolveReadableAssetPath`、`WorkspaceFs.abs`）。工作区写入只落在 `$DSH_HOME/dsh-tavern/` 内。工具不得读取 `state/wal/` 或二进制资源。
- remote 入参由 typert gateway 按 zod schema strict 校验。复杂资产用宽松 schema 传输，由存储层归一化时严格校验。不要在 service 层信任原始 JSON。

## 数据布局（运行期，`src/node/paths.ts`）

```
$DSH_HOME/dsh-tavern/
├── characters/<cardId>/     # 每角色工作区：card.json/png、assets/、memory/、
│                            # state/（world-delta.jsonl、wi-timers/、wal/）、journal.md、index.json
├── library/lorebooks/  library/presets/
├── personas/  regex/rules.json
├── siblings.json            # 分支兄弟索引（楼层 fork 的 ‹ n/m › 导航）
└── sessions/<sessionId>.json
```

库资产解析结果有进程内 rev-keyed 缓存：经 `TavernState` 写方法编辑会 bump 修订号并失效缓存；绕开它手改文件不被捕获（重启即清）。`loadBinding` 走快路径——cardId 仍在时不做全库扫描，卡失效才全量接回。

`cardId` 是目录名，不是 UI 标题。`sessions/*.json` 以卡为单位引用该 ID；卡删掉后必须清绑定或按名字接回新目录。

agent 预设目录 `$DSH_HOME/.agent-presets/tavern/` 由插件托管，升级会覆盖，请勿手改。这一整棵目录是本机数据，不进 git。

## 部署

- 交付：`package.json` 声明 `dsh.bundle.patch = cordis.patch.yml` 与 `dsh.client`。`npm pack` 白名单只含 `lib/`、`cordis.patch.yml`、`presets/`、README（中英两份）、CHANGELOG.md 和 LICENSE；发布前必须通过 `npm pack --dry-run`。版本与 dsh 的对应关系记在 `CHANGELOG.md`。
- 安装：`dsh plugin --profile web add github:Amakurai/dsh-liketavern`。开发把仓库挂进 `~/.dsh/profiles/node_modules/dsh-liketavern` 再 `npm run dev`——Windows 用 junction，macOS/Linux 用 symlink（命令见 README 开发节）。
