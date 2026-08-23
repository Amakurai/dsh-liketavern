# AGENTS.md

给要改这个仓库的人（包括编码代理）看的约定。读完再动手。用户向说明见 [README.md](./README.md)。

## 这是什么

dsh-liketavern 是 DeepSeek Harness（dsh）插件，把 `dsh web` 做成 SillyTavern 式的角色扮演前端。角色卡（V1/V2/V3，PNG/JSON）、提示词预设、世界书、人设、正则、BM25 长期记忆、世界状态变化层，以及可回滚的楼层操作，都建在 dsh 的 agent 运行时上，而不是另起一套发信通道。

和 SillyTavern 最不一样的四件事，改代码时请按这个想：

1. **资产文件化**。导入的卡、世界书、预设落成工作区文件。agent 按需按条读，不要每轮全塞进 prompt，也不要把整本 JSON 灌进工具结果。
2. **多步思考**。一轮回复可以走多步 agent 循环：缺设定再检索，必要时写记忆或更新世界状态，最后一步才出正文。默认直接扮演，不要每轮例行调工具。
3. **楼层事务**。用户对某一层触发的写入（记忆、世界状态、定时器）必须能撤销。工作区写入走 WAL（楼层号 + 序号），回退就是逆序回放。例外：记忆超容量时的异步压缩在 idle 期 `runMaintenance` 执行，`floor=null` 不记 WAL，回退不会撤压缩——那是无损整理，不增删剧情事实。
4. **不复制 ST 的一次性输入**。提示词走 dsh 的 system-prompt 组装瀑布（稳定段 + runtime context）。不要在前端拼包直发，也绝不要用 `complete` 段盖掉工具前缀。

实测环境：dsh `0.1.1-rc.2`（`@deepseek-ai/*` 同版本），Node 24，Windows（CI 在 ubuntu 上跑 build/test）。依赖 rc.2 特有宿主行为的地方集中列在「宿主版本注记与升级」一节。

**查平台行为先看官方文档**：<https://deepseek-harness.github.io/deepseek-harness/>（上手：[guide/quickstart](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)；插件开发：[develop/basic](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)，含打包安装、profile/bundle、patch 层顺序）。涉及宿主机制（slot、profile、patch、typert、system-prompt 瀑布等）的判断以官网文档和宿主源码为准，不要凭记忆猜。

**查宿主源码看 npm 包**：`@deepseek-ai/dsh` 及其依赖（`dsh-agent`、`dsh-session`、`dsh-system-prompt` 等）在 devDependencies 里锁定精确版本，`npm install` 后直接读 `node_modules/@deepseek-ai/dsh/` 和兄弟包里的 `lib/` 与 `.d.ts`。本地没装时看 npm registry 的 Code 页：<https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=code>，依赖包同站换包名。注意 `@deepseek-ai/dsh` 本体版本与 peer 包版本可能不同，先看 `node_modules/.../package.json` 确认实际版本再读代码。

运行期角色卡、记忆、会话绑定在 `$DSH_HOME/dsh-tavern/`，不在本仓库。不要为了方便调试把真实卡拷进 git。测试用手写工厂数据。

## 技术栈与三面运行

- TypeScript ESM（`"type": "module"`），`module: NodeNext`，strict + `noUncheckedIndexedAccess`。
- 宿主是 dsh（cordis 容器），分三面：
  - **host**（`src/index.ts`）：注册设置命名空间 `dsh-tavern`、初始化数据目录、安装 agent 预设、提供 `tavern` 服务（`TavernService`）、注册 typert remote、听 `session/event` 维护楼层 WAL 和每 turn/step 缓存。
  - **agent**（`src/agent.ts`）：由插件安装的 `tavern` 预设挂载（`presets/tavern/agent.cordis.yml`，启动时替换 `__AGENT_MODULE__`）。在 `system-prompt/assemble` 写入稳定段 `tavern:standing` 和 runtime context `tavern:turn`；`agent/pre-step` 记 step；`agent/request` 合入采样，并把 thinking 映射成 `reasoningEffort`（模型元数据经 `resolveModelInfoCached` 进程内缓存）；注册 7 个模型工具；`agent/status` 转入 idle 时 `runMaintenance` 做记忆压缩。
  - **client**（`src/client/`）：浏览器 React UI。五块 slot：设置 `settings.section`、助手操作条 `conversation.chat.assistant-actions`、会话头芯片 `conversation.session.header.actions`、新会话英雄区 `conversation.input.dock`、助手排版 `conversation.chat.node`（`assistant-step`，priority -1）。经 `ctx.remote.$mount(TYPERT_REMOTE)` 挂 remote，调用时用 `ctx.get('remote.tavern')`。rc.2 起 chat.node 的 owner props 不再给 `loadImage`，图片走 `renderMessageImages({ images, align })`；`fileMentions` 是 owner 函数，要像原生 AssistantNodeView 那样用 turn-tail owner 解析后再传给 MarkdownText。
- host 和 client 用 typert RPC，契约在 `src/remote.ts`（`METHODS` 表 → 描述符）。方法返回裸业务值，失败抛错。`{ ok, value | error }` 信封由 gateway 生成，service 层不要再包一层。加删改一个方法要同步三处：`src/remote.ts` 的 `METHODS`、`src/node/service.ts` 的实现、`src/client/types.ts` 的 `TavernRemote`——最后这个是手工维护的契约镜像，漏改就编译不过。
- 运行时依赖只有 `zod`。直接使用的 `@deepseek-ai/*` 以 peerDependency 声明，由 dsh 宿主提供；开发依赖使用公开 npm 的精确版本。禁止 `file:`、本机绝对路径、junction 或符号链接依赖。host/client bundle 里平台模块一律 external。
- 设置用 schemastery（`src/node/config.ts`），命名空间 `dsh-tavern`，用户覆盖在 `~/.dsh/settings.yaml`，`applies: 'live'`。包括采样（含 thinking 档位）、世界书全局、记忆、新会话默认绑定 `defaults`、`interactiveCards`、`cardNetworkWhitelist`、`cascadeDeleteEmbeddedBook`（删卡时是否连同内嵌世界书，默认开；关掉则删卡前把内嵌书抢救到世界书库）。rc.2 起 web 设置 RPC 的命名空间白名单已移除，宿主通用设置文档页也能看到/改 `dsh-tavern` 的键——这是宿主行为，插件面板仍是主入口，不要为此改面板。

## 提示词通道与 agent 循环

live 路径不把整包 ST 预设塞进 system。`assemblePrompt` 按 Prompt Manager 算出全量序列（给预览），再拆成两条 dsh 通道：

| 通道 | dsh 落点 | 内容 | 稳定性 |
| --- | --- | --- | --- |
| standing | system 段 `tavern:standing`（order 210，工具说明 100–199 之后） | `BOUND_DISCIPLINE` + 角色定义 + 预设骨架 + 常驻世界书 + 静态深度注入（无本轮宏的 in-chat 条目 / depth_prompt） | 绑定不变则按会话 × 生成场景钉死字节（`STANDING_PIN_VERSION` + generationType + 卡/预设/人设指纹 + 资产修订号）。纪律或段布局变了必须递增版本，否则进程内旧钉死会挡住新文案。编辑/删除预设与世界书经 `TavernState` 写方法 bump 修订号（`standingRevTags`）。绕开 TavernState 手改文件不会被捕获。 |
| turn | runtime context `tavern:turn` | 固定 `TURN_PLAYBOOK`（不随 step 变）+ 关键词世界书/记忆/变化层/AN/本轮宏 | dsh 追加成 user 快照（`Current runtime context.`），盖住更早的同名快照；宿主对快照按字节去重——同轮后续步骤快照不变则不再追加（多步零快照开销）。步骤收口压力走 `【Tavern 步骤】` inject（见下）。 |
| messages | 仅「预览提示词」 | 完整 ST 序列（含 @D 真实插历史位置） | live 请求插不进会话日志中间；排查以预览为准。 |

时钟在 standing 里冻结。残留 `{{…}}` 写入 dsh 段前要 `neutralizeDshMustache`。未绑卡时不要删掉 `tavern:standing` 段，只换成 `UNBOUND_STANDING` 短文案，避免段布局抖动打穿 KV。

turn 层预算（`core/turnBudget.ts`）：runtime context 快照对新请求永远是**未缓存前缀**（DeepSeek 前缀缓存只认追加点之前的字节），快照里的大体量内容 = 每轮全价重付。因此世界书层用固定 `tokenBudget`（默认 8192，绝对上限，不随历史长度/窗口缩水；百分比路径折算基数 clamp 到 128K，防 1M 窗口把 25% 放大成 25 万），且只计搭快照通道的条目——落 standing 的常驻（constant 且无本轮宏，`isStandingSafeEntry`，引擎与渲染共用）豁免计费，也豁免概率掷骰（恒定注入：掷骰本就被钉死冻结成每会话一次，fork 分支换种子重掷只会打穿整个 system 前缀缓存）。被裁条目进 `truncated`、快照尾部附 uid 清单（封顶 8 条），模型按条 `tavern_lore_read` 补读，硬顶是分页不是丢信息。世界书与记忆段落落消息时带来源标签（standing 侧 `【世界书·常驻】`、turn 侧 `【世界书·本轮触发】`、记忆 `【检索记忆】`；AN 走 `wiText` 不加标签），否则裸文本拼接模型难以识别为设定事实。变化层按 `WORLD_DELTA_TURN_BUDGET`（1500）从最新往旧装载，预算只计本轮实际渲染的条目（无键常驻 + 已命中，判定共用 `isDeltaRenderedInTurn`），更旧的丢给 `tavern_lore_read(source=delta)` 补读；记忆（1200）与 journal（800）各自有顶。被裁不要心疼——工具按条补读是设计内路径。触发日志里 `[turn:tail]` 行观测每轮尾巴体积、`[standing:pin]` 行观测 standing 钉位命中/重算。

多步循环，不要为了省 I/O 跳过每步组装：

- 世界书和记忆检索每 turn 只评估一次（定时器以消息数为单位，同轮复用 `wiCache`；`lastCharMessage` 与 `journalText` 也随 `wiCache` 同轮冻结——history 增长或 journal 中途编辑不得改变同轮快照字节，否则宿主按字节去重失效）。
- 每步仍跑 `runTavernPipeline`，把本轮快照重放进 `tavern:turn`。playbook 固定后同轮快照字节不变，宿主去重不再追加；长上下文会忘，靠最新 runtime context 加按条工具补读。
- 工具写入不重评世界书（避免 sticky/cooldown 同轮连 tick）。检索层下一 turn 才更新。写成功后 `agent.inject` 一条 `【Tavern 同轮写入】…`（`form: 'notice'`），下一步看得到。
- 步骤收口通知（`formatTurnStepNotice`，按 `turn:nextStep` 去重）只能在工具执行时注入（`node/tools.ts` 的 `maybeInjectStepNotice`，7 个工具全覆盖）。不要在 `agent/pre-step` 里 inject：注入要等下一步 preStep 才被认领（晚一步），且 turn 结束判定会把未消费的 nextStep 输入当成续步理由，强行多拉一步产生孤儿通知。
- 合成 user 文本（runtime context 快照、同轮写入确认、步骤收口通知）走 `isSyntheticUserText`：不当 `{{lastusermessage}}`，不扫世界书，不计入正则 depth。

采样 / thinking：`agent/request` 透传 `temperature` / `maxTokens` / `stop`，并按当前模型公布的 reasoning 档写 `reasoningEffort`（disabled → `off`；low/high/max → 公布才显式指定，否则回退自动；enabled → 保留会话已选的非 off 档，否则模型默认——默认档的思考可能很短，要长思考引导用户选 high/max）。只发送适配器公布的 id。部署把 `llm-deepseek.thinking` 锁成 `disabled` 时，插件无法强行打开。

## 模型工具（7 个）

注册在 `src/node/tools.ts`。默认直接扮演；只在缺设定、长上下文遗忘、或要把本轮已确定事实落盘时调用。

| 工具 | 用途 |
| --- | --- |
| `tavern_memory_search` | BM25 检索。runtime context 里的记忆不够再用。 |
| `tavern_memory_write` / `update` | 只记事实与关系/状态变化。去重；超容量时标记 `pendingMemoryCompress`，turn 结束后 `runMaintenance` 异步压缩最旧批次（`memoryMaintenance.ts`，不记 WAL）。写成功 inject 同轮确认。 |
| `tavern_lore_read` | 先目录再取条。无参 = uid/键/摘要目录；`uid` 或 `query` 取正文（有 token 预算）。含全局/角色/会话/变化层，disabled 条目仍可读。禁止整本 JSON 倾倒。 |
| `tavern_worldstate_update` | add/update/invalidate。写成功同样 inject。 |
| `tavern_asset_list` | 工作区文件 + 绑定预设条目目录。 |
| `tavern_asset_read` | `path` 读工作区文本（`journal.md`、`memory/*.md`、`assets/*.json` 等）；`preset: list` 列预设，`preset: identifier` 取正文（含未启用）。拒绝绝对路径、`..`、WAL、图片。 |

工作区路径必须经 `WorkspaceFs`（越界抛错）+ `resolveReadableAssetPath`（可读白名单）。不要加通用任意文件读取。

## 构建与测试

```bash
npm install        # dsh 开发依赖从公开 npm 安装
npm run build      # tsc -p tsconfig.json（产出 lib/ 含 .d.ts）+ node scripts/build-client.mjs
npm test           # vitest run：33 个文件、约 460 例（例数随改动浮动，不是精确值）
npm run dev        # dsh web --patch ./cordis.dev.yml（需先建 junction，见 README）
```

构建是两段式：先 `tsc` 把 `src/` 编到 `lib/`（含 `lib/client/index.js`），再由 `scripts/build-client.mjs` 用 esbuild 打成单文件 CJS bundle `lib/client.js`，外包 `window.__ModuleLoader__.load` 注册壳。宿主提供的 react、cordis、dsh-client-* 保持 external。产物带自检。

`lib/` 是交付物，刻意入库，`.gitignore` 不要忽略它。改代码后必须重新 `npm run build`。角色卡、运行期 JSON、图片、会话、记忆和本机 `file:` 依赖不能进入 Git 或 npm 包。

CI（`.github/workflows/ci.yml`）：push / PR 在 ubuntu + Node 24 跑 `npm ci` → build → test，然后 `git diff --exit-code lib/` 校验入库产物与源码构建一致（忘跑 build 就提交会被拦下），最后 `npm pack --dry-run` 校验白名单。行尾靠 `.gitattributes`（`* text=auto`）保证 Linux 上校验可复现。

没有独立的 vitest/tsc lint 配置。测试用 vitest 默认约定，直接 `import` `src/`，不必先构建。

## 代码结构

```
src/
├── core/       纯函数层（无 I/O，全部可单测）
│   ├── types.ts            共享类型与默认值（DEFAULT_SAMPLING / DEFAULT_WI_SETTINGS）
│   ├── assemble.ts         ST 语义组装（骨架+常驻世界书进 standing，关键词/记忆进 turnContext）
│   ├── worldbook.ts        世界书触发引擎
│   ├── regex.ts            正则管线
│   ├── macros.ts           ST 宏（setvar/getvar 是组装前预处理）
│   ├── tokenize.ts         分词、token 估算、clipToTokenBudget
│   ├── memoryRetrieval.ts  记忆检索结果的时间衰减与预算挑选
│   ├── turnBudget.ts       turn 层预算：WI 百分比基数 clamp、变化层按预算保最新
│   ├── loreQuery.ts        世界书目录 / 按条筛选
│   ├── assetRead.ts        工作区路径消毒与预设条目目录
│   ├── callConfig.ts       采样合入 + reasoningEffort 挑选
│   ├── standingPin.ts      会话 standing 钉死
│   ├── dshPrompt.ts        纪律文案、turn playbook、合成 user 文本、Mustache 中性化
│   ├── persona.ts          人设解析 / 默认 {{user}} 名
│   ├── greetingLog.ts      开场白楼层识别
│   ├── tavernMode.ts       tavern 预设 id 判定
│   ├── displaySanitize.ts  展示向收起机读标签
│   ├── bm25.ts             BM25 + 时间衰减
│   ├── binding.ts          陈旧会话绑定回收
│   ├── siblings.ts         分支兄弟索引（同父同层 fork 成组、位次、悬空剪枝）
│   └── cardFrame.ts        交互卡 srcDoc：CSP + ST stub + postMessage
├── state/      存储层（文件 I/O，落 $DSH_HOME/dsh-tavern/）
│   ├── card.ts / lorebook.ts / presetStore.ts / memory.ts / worlddelta.ts
│   ├── siblings.ts         分支兄弟索引存储（siblings.json；导航元数据，不记 WAL）
│   ├── workspace.ts / workspaceFs.ts / wal.ts
├── node/       host 运行时
│   ├── config.ts / paths.ts / state.ts / service.ts / pipeline.ts
│   ├── floors.ts / greetingSeed.ts / tavernSession.ts / tools.ts
│   ├── impersonate.ts  AI 代答用户：带外一次性 LLM 调用，不开 turn 不记 WAL
│   ├── memoryMaintenance.ts / bindings.ts / presetInstall.ts
├── client/     浏览器 UI
│   ├── index.tsx / mode.ts / chip.tsx / hero.tsx / seatWatch.ts / seatChip.tsx
│   ├── speech.tsx / assistant.tsx / actions.tsx / openChild.ts
│   ├── util.tsx / styles.ts / locales.ts / types.ts
│       types.ts = TavernRemote 契约镜像（改 remote.ts / service.ts 必须同步）
│   └── panel/  设置子面板：characters / presets / lorebooks / lorebookEditor /
│               personas / regex / memory / settings
├── index.ts    host 入口
├── agent.ts    agent 面入口
└── remote.ts   typert 契约
```

对应测试在 `test/`（33 个文件，约 460 例）：core/state 纯逻辑，加上 binding、cardFrame、workspace、floorsForkOptions、greetingSeed、stateRuntime、openChild、siblings、presetInstall 等。host 事件与 client UI 不测。

## 代码风格

- 注释和文档用中文，标识符用英文。每个源文件用块注释说明职责。跨层约定（信封、定时语义、WAL、封面桥、合成 user 文本）写在使用点。
- ESM 显式扩展名：相对导入一律写 `.js`（NodeNext），包括 client TSX。
- 类型：strict + `noUncheckedIndexedAccess`；`exactOptionalPropertyTypes: false`。数组/索引访问要处理 `undefined`。
- cordis 插件：导出 `name` / `inject` / `apply(ctx)`。经 `ctx` 注册的会自动清理；需手动清理的用 `ctx.effect()`。
- 分层：`core/` 不 import `node:fs`；I/O 只在 `state/`；编排只在 `node/`。client 不直连平台内部 API，只走 typert remote。
- client 不能 `inject: ['remote.tavern']`（`$mount` 在 apply 内自装，声明会死锁）。用 `ctx.get('remote.tavern')`，不要写 `ctx.remote.tavern`（追踪代理会按 inject 检查）。
- UI 对齐 dsh 原生：按钮、菜单、弹窗、通知走 `@deepseek-ai/dsh-client-ui-primitives`（封装见 `src/client/util.tsx`）。禁止原生 `<select>`（Windows 上 option 白底白字）。样式只进 `src/client/styles.ts`。颜色只用真实存在的 `--dsw-*` 令牌，不要引用悬空变量（例如 `--dsw-alias-error`、`bg-elevated`、`fill-tertiary`）。动效用 `--ds-ease-in-out` 加 0.1/0.2/0.3s，并遵守 `prefers-reduced-motion`。设置行 = 标题 + 说明 + 右侧 36px 胶囊（`SettingsRow`，宽控件用 `stacked`）。确认用 `ConfirmDialog`，不用 `window.confirm`；瞬时反馈用 `useToast`；加载用 `Skeleton`；头像用 `Avatar`；可点卡片用 `clickableProps`。
- 展示名永远用 `card.name`。不要把工作区文件夹 `cardId`（净化名 + 8 位 hash）当成角色名。头像走 `getAvatar({ cardId })` 的 PNG dataURL。
- `settings.section` 的 slot label 走 `locales.ts`；面板和对话 UI 目前直接写中文，不要半中半英。

## 测试策略

- `npm test`（vitest run）。改 `core/`、`state/` 必须同步更新或新增对应测试。
- 测试直接 `import ... from '../src/<层>/<模块>.js'`。
- 每个测试文件开头用中文块注释列覆盖点。用手写工厂构造全字段默认值（如 `makeEntry`）。枚举和默认值从 `src/core/types.ts` 导入，不要复制字面量。
- 覆盖重点是确定性纯逻辑：世界书触发全矩阵、宏、正则、BM25、预设/卡/世界书归一化、WAL 回滚、工作区、`resolveStaleBinding`、交互卡 CSP/ST stub、standing 钉死、lore 按条筛选、资产路径消毒、reasoningEffort 挑选、合成 user 文本。host 事件与 client UI 不测。
- 不要把真实角色卡、世界书导出或会话绑定放进 `test/`。

## 平台限制（开发者视角；用户向简版见 README「平台限制」一节）

1. 采样只透传 `temperature` / `maxTokens` / `stop`，以及模型公布的 `reasoningEffort`（Tavern「深度思考」关 → `off`；低/高/最高档仅在模型公布时显式指定）。`top_p` 和 penalty 到不了模型，设置面板仅作记录。
2. 深度注入（@D / depth_prompt / 预设 in-chat）在实际请求中插不进会话日志中间：触发型（含本轮宏）并入 turn 快照尾部，静态的并入 standing（system 段内，钉死）。预览才是完整 ST 序列（不含 live playbook）。
3. 会话日志不可删。重新生成/回退/编辑 = fork 前缀 + WAL 回滚 + 子会话续跑，成功后 UI 打开分支会话，并用宿主 `ISessions` 的 `scope → sessionOf → rename` 把 host 给的分支标题写进会话列表（旧宿主缺这条路径则跳过）。编辑 assistant 正文只换 seed 里的该条消息、不续跑。例外：续写（`continueFloor`）不改历史，不 fork，直接 followup 合成指令。同一父会话 + 同一楼层 fork 出的分支互为兄弟：forkAt 记 `siblings.json`，操作条给 ‹ n/m › 兄弟导航（`getFloorSiblings`，读时按 live/绑定文件过滤已删分支）。rc.2 起会话头另有宿主原生面包屑（按 fork 时写入的 `meta.parentSession` 算世系，`conversation.session.header.lineage` 由 subagent 插件占位渲染）：那是会话级世系，与楼层级 ‹ n/m › 互补，不要去替换那个 slot。
4. 操作条 slot 只在 assistant 消息上。「编辑用户消息」/续写/代答都挂在 assistant 楼层。dsh 输入区没有插件可写 API，impersonate 结果只能复制到剪贴板。
5. 同一角色卡多会话并发写入会交错（工作区与 WAL 以卡为单位共享）。这是已知边界，不要去「修」。
6. 角色选择和开场白预览只在 agent 预设为 `tavern`（`src/client/mode.ts`）时显示。

## 常用改动 checklist

- **加/改 remote 方法**：三处同步——`src/remote.ts` 的 `METHODS`、`src/node/service.ts` 实现、`src/client/types.ts` 契约镜像（漏改编译不过，这是设计好的保险）。返回裸业务值、失败抛错，信封由 gateway 生成。
- **加模型工具**：在 `src/node/tools.ts` 注册，工具描述里写清「默认直接扮演，只在缺设定/遗忘/落盘时调」的分寸；工作区路径必须过 `WorkspaceFs` + `resolveReadableAssetPath`；写工具成功后 `agent.inject` 同轮确认；同步更新本文「模型工具」表。
- **加设置项**：`src/node/config.ts`（schemastery，`applies: 'live'`）+ `src/client/panel/settings.tsx`（`SettingsRow`：标题 + 说明 + 右侧 36px 胶囊，宽控件 `stacked`）+ `settings.section` 的 slot label 进 `locales.ts`。默认值有跨层引用时放 `src/core/types.ts`。
- **加/改 UI**：样式只进 `src/client/styles.ts`；交互组件走 `dsh-client-ui-primitives`（封装在 `util.tsx`）；禁止原生 `<select>` 与 `window.confirm`。
- **改 standing 纪律文案或段布局**：递增 `STANDING_PIN_VERSION`（`src/core/standingPin.ts`），否则进程内旧钉死会挡住新文案。
- **任何 `src/` 改动**：先 `npm run build` 再提交，CI 会用 `git diff --exit-code lib/` 拦下过期产物。

## 宿主版本注记与升级（当前 dsh 0.1.1-rc.2）

以下行为绑定 rc.2，升级宿主时逐条复查；成立与否以官方文档和宿主源码为准，不要凭记忆猜：

1. chat.node 的 owner props 不再提供 `loadImage`，图片走 `renderMessageImages({ images, align })`；`fileMentions` 是 owner 函数（详见「技术栈与三面运行」client 条）。
2. web 设置 RPC 的命名空间白名单已移除，宿主通用设置页也能看到/改 `dsh-tavern` 的键——宿主行为，不要为此改插件面板（详见「设置」段）。
3. 会话头有宿主原生面包屑（按 `meta.parentSession` 算世系，`conversation.session.header.lineage` 由 subagent 插件占位渲染），与楼层级 ‹ n/m › 互补，不要替换那个 slot（详见「平台限制」第 3 条）。

升级 dsh 的检查清单：

- `package.json` 三处版本同步：`peerDependencies`、`overrides`、`devDependencies`（全部精确版本，不带 `^`）。
- 逐条复查上面三条注记在新宿主上是否仍成立，失效的改掉并从本节删除。
- 对照官方文档的 breaking changes：slot、profile/bundle、patch 层顺序、system-prompt 瀑布、agent 事件。
- `npm install` → `npm run build` → `npm test` → `npm pack --dry-run`。
- 在 `CHANGELOG.md` 记一行适配的 dsh 版本。

## 动手前必知（近期踩过，不要回退）

1. **`cardId` 不是显示名**。`newCardId` 是净化名 + `sha1(name+随机)` 前 8 位，同名片互不覆盖。删卡再导入是新 ID。`TavernState.loadBinding` 必须走 `resolveStaleBinding`（按 `cardName`，或库里只剩一张卡时接回）。`deleteCharacter` 必须 `clearBindingsForCard`。回收失败则删绑定文件，视为未绑定。
2. **导入角色卡**先 `inspectCharacter`（不落盘）。有内嵌世界书时用 DSH `Modal` 询问。`importCharacter({ importWorldBook })` 为 false 时不写 `assets/character-book.json`，且 `card.json.characterBook = null`。
3. **卡内嵌世界书**可从 `data.character_book`、顶层、`extensions` 多处解析。设置「世界书 → 角色卡内嵌」和芯片主世界书空选项都要能看到。管线读卡内书，不要只扫 `library/lorebooks`。`tavern_lore_read` 必须走 `loadBoundLoreEntries`（全局+角色+会话+变化层），不要只 dump `character-book.json`。
4. **封面 HTML**（output/render 正则把标记换成整页 HTML）：`SpeechBubble` 用 `sandbox="allow-scripts"` iframe。`regex_scripts` 常在 V3 `extensions` 里，展示向规则默认启用（`disabled: true` 才关）。抽 HTML 见 `extractRenderedHtml`（含 text 代码围栏）。
5. **封面外网图默认放行**。CSP 在 `src/core/cardFrame.ts`：`img-src` / `font-src` 允许 https/http/data；`connect-src` 默认 `'none'`。`cardNetworkWhitelist` 放宽脚本 fetch 与外部脚本（`*` = 全部放行）。不要改回「白名单为空则禁止一切图片」。
6. **交互卡里切 swipe 的按钮必须真的能点**，不要改成纯文档说明。注入 ST / JS-Slash-Runner stub，经 `postMessage`（`source: 'dsh-tavern-card'`）只允许 `swipeGreeting`。禁止 `allow-same-origin`，禁止通用主窗口桥。
7. **非会话写入不记 WAL**。导入/设置改文件时 `WorkspaceFs` 的 floor 为 `null`，跳过快照。不要复活名为 `non-floor` 的 WAL 单元。
8. **新对话不自动选卡**。`settings.defaults` 只在用户点选角色时套用。`hero.tsx` 不得根据 `defaults.cardId` 自动绑定，也不得在已有绑定上自动 `ensureGreeting`。空白 Tavern 会话若仍带着上次留下的绑定文件，英雄区应清掉。楼层 fork 必须走 `agents.create`（id 前缀 `session-`）+ `workspace.attachSession`，禁止 `ctx.sessions.fork` 或 `tavern-` 前缀。create 必须带父会话的 `agentOptions`（provider/model，优先 `requestHeader`），否则子会话立刻 followup 时 `deployment:persona` 的 `{{model}}` 无值。开场白 swipe 要把新 turn 放进 create 的 seed。客户端 `refresh` 列表后再 `open` 子会话（`openChild.ts`）。无会话 hero 上选「Tavern 模式」时，宿主只暂存选择，`seatWatch.ts` 会代为 `workspaces.startSession()`——不要删这个补偿。
9. **`{{setvar}}` / `{{getvar}}` 是组装前预处理**，不是扔给模型。一次 `assemblePrompt` 共享 `Map` store；set 条目展开后变空并省略；后写覆盖先写。`{{lastusermessage}}` / `{{outlet}}` / 时钟进 `turnContext`，不要为了「完整 ST」把它们写进 `tavern:standing`。不落盘，不做 if/dice/STscript。预设内嵌 `regex_scripts` 随预设导入（`compilePresetRegexScripts`，跟脚本 `disabled` 走）。UI 开关直接改写预设文件的 `disabled`。常驻世界书（constant、无本轮宏）进 standing。
10. **不要把整包 ST 改成 `complete` 段。** standing 放在工具说明之后（order 210），工具前缀才能命中 DeepSeek KV。turn playbook / 本轮世界书/记忆只能进 `tavern:turn`。
11. **不要整本倾倒世界书，也不要在 step>1 跳过组装。** `tavern_lore_read` 先目录再 uid/query；`tavern_asset_read` 按文件或预设条目读。step>1 仍组装，是为了长上下文下重放本轮快照。
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

库资产（预设 / 世界书 / 角色卡）的解析结果有进程内 rev-keyed 缓存：经 `TavernState` 写方法编辑会 bump 修订号并失效缓存；绕开 `TavernState` 手改文件同样不被捕获（与 standing 钉死同一语义，重启即清）。`loadBinding` 走快路径——cardId 仍存在时不做全库扫描，只有卡失效才全量接回。

`cardId` 是目录名，不是 UI 标题。`sessions/*.json` 以卡为单位引用该 ID；卡删掉后必须清绑定或按名字接回新目录。

agent 预设目录 `$DSH_HOME/.agent-presets/tavern/` 由插件托管，升级会覆盖，请勿手改。

这一整棵目录是本机数据，不进 git。`.gitignore` 也会拦住误拷进仓库的卡和图片。

## 部署

- 交付：`package.json` 声明 `dsh.bundle.patch = cordis.patch.yml` 与 `dsh.client`（platform web、inject `@deepseek-ai/dsh-client-runtime`）。`npm pack` 白名单只含 `lib/`、`cordis.patch.yml`、`presets/`、README（中英两份）、CHANGELOG.md 和 LICENSE；发布前必须通过 `npm pack --dry-run`。版本与 dsh 的对应关系记在 `CHANGELOG.md`。
- 安装：`dsh plugin --profile web add github:Amakurai/dsh-liketavern`（内部走 profile 下的 pnpm）。开发把仓库挂进 `~/.dsh/profiles/node_modules/dsh-liketavern` 再 `npm run dev`——Windows 用 junction，macOS/Linux 用 symlink（命令见 README 开发节）。
