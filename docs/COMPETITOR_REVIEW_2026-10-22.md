# 同类项目对照与本轮修复（2026-10-22）

对照对象优先取 dsh 生态内的酒馆/角色扮演插件与提示词注入插件，其次是 SillyTavern 本体的 issue。只记录与本插件机制重合、能落到代码上的结论。

## 一、本轮修复（已带测试）

| # | 问题 | 来源线索 | 修复 | 测试 |
| --- | --- | --- | --- | --- |
| 1 | `card.json` 缺失/损坏时，读取绑定把「卡不可读」当成「卡已删除」自愈：库里只剩另一张卡时会话被静默改绑并新建剧情；多张卡时绑定文件被删除 | SillyTavern #5941（读失败返回空 → 被当作空聊天写回覆盖） | `TavernState.loadBindingNow` 在卡目录仍存在时明确报错，只有目录不存在才走 `resolveStaleBinding` | `test/bindingCorruptCard.test.ts` |
| 2 | `markdownOnly` 把 placement=用户输入的正则改写成作用于 assistant；用户气泡美化正则（如 `^(.*)$` → `<div class="user-bubble">$1</div>`）会包裹每条 AI 回复；placement=世界书 + markdownOnly 会作用于所有 AI 气泡 | SillyTavern `regex/engine.js` 的 `getRegexedString`：`script.placement.includes(placement)` 在任何情况下都是前提 | `compileRegexScripts` 保留 placement 推出的 roles；仅世界书 placement 的显示层去掉；`applyRegexRules` 在 output 作用域跳过不含 assistant 的规则 | `test/regex.test.ts` 新增 3 条、修正 2 条旧断言 |
| 3 | standing / turn 段依赖宿主默认插值，只能把 `{{`/`}}` 改写成全角以免整轮抛错，模型看到的人设原文被篡改 | dsh-purge 研究（`docs/PURGE_INJECTION_STUDY.md` §2.3 P0）；chen731215-dev/dsh-tavern-v2 #9（`unknown prompt variable "{{user}}"`） | 两处注册与运行期补挂都声明 `interpolate: false`，段文本路径不再全角化；`STANDING_PIN_VERSION` 26→27 | `test/promptInterpolation.test.ts`（真实 SystemPrompt/AgentLoop 渲染） |

### 第二轮修复（已带测试）

| # | 问题 | 来源线索 | 修复 | 测试 |
| --- | --- | --- | --- | --- |
| 5 | 局域网 `http://` 打开宿主时（非安全上下文）`crypto.randomUUID` / `crypto.subtle` 不存在，气泡、脚本运行器、MVU 回执与卡面桥接整段抛错 | flizzywine/dsh-tavern #41 | 新增 `src/core/secureRandom.ts`（`getRandomValues` 拼 v4 UUID、纯 JS SHA-256 回退）；主页面 6 个文件改用它；`cardFrame` 在 iframe 内补 `crypto.randomUUID` | `test/secureRandom.test.ts` |
| 6 | 未识别 ST 新版宏名 `{{charDescription}}` 等，原样漏给模型；缺 `deletevar`/`flushvar`/`varexists` | bychv/dsh-preset-enhance 宏表、ST `macros/definitions/*.js` | 宏引擎与依赖分析补齐；删除与读取同趟按出现顺序执行（先读后清） | `test/macros.test.ts` |
| 7 | 多条「组内优先」在其中随机；`group` 不支持逗号多组 | SillyTavern #5748、`world-info.js` `filterByInclusionGroups` | 优先条目取 order 最大者；按逗号拆组，任一组落选即排除 | `test/worldbook.test.ts` |

### 实机验收（2026-10-22）

独立临时 `DSH_HOME`（`.tmp/smoke-20261022`），真实 dsh `0.2.1-rc.2` CLI 经 `dsh plugin --profile web add` 安装当前 tgz（安装后文件与构建逐一比对一致），启动 `dsh web`；模型请求只发往本机 loopback 上的手写 Messages/SSE 端点，未调用真实模型、未读取用户数据。内置浏览器操作：

- 选择 Tavern 模式、选卡、连续 4 轮对话正常；开场白与回复的 AI 显示正则生效，用户气泡美化正则（placement=用户输入 + markdownOnly）未套到 AI 回复（DOM 与请求体均无该包裹）。
- 实际请求体：`{{charScenario}}`、`{{charVersion}}` 已展开；`{{未知宏}}`、`{{ item.name }}` 原样到达，无全角括号；世界书两条「组内优先」中选中 order 9999 的完整档案。
- 旧本轮快照诊断：两轮上下文相同时宿主不追加快照，显示 0；新增会话世界书条目后显示「1 份，约 689 token；DeepSeek 通道发信前已剔除」，与请求体一致（旧快照中的 `tavern:turn` 段确已剔除）。重启宿主后按落盘历史重新统计。
- 永久删除：解除绑定后残留剧情的收纳卡，确认框列出剧情并成功删除（磁盘目录移除）；仍被会话绑定的卡标注「仍被会话绑定」，确认按钮禁用。
- 删除页面中的 `crypto.randomUUID` 与 `crypto.subtle`（模拟局域网 http）后，气泡重新挂载与第 4 轮对话均无错误。
- 实操发现并已修复：设置页角色卡说明仍写「永久删除只在没有任何引用时开放」；删除框剧情时间显示 UTC 而非本地时间；旧快照诊断行放在用量块之外。修复后重装复核通过。
- 宿主日志无错误；临时服务已停止、端口释放，临时数据副本已删除（保留脚本、日志与合成请求）。

## 二、已核对、本插件不受影响的同类坑

| 同类问题 | 本插件现状 |
| --- | --- |
| Player-MINEPIG/dsh-tavern #20：注入的 `<style>` 没有 `data-plugin`，被宿主 HMR 认领后误删 | rc.2 宿主已改为只认领 factory 执行期间新建的样式；`ensureTavernStyles` 在模块加载时同步注入，归属正确 |
| chen731215-dev/dsh-tavern-v2 #1：写死 `~/.dsh`，桌面版 `DSH_HOME` 重定向失效 | `src/node/paths.ts` 走宿主 `dshHomePath` |
| a86582751/dsh-nexttavern #17：维护任务失败后滞留，`/compact` 永久被拒 | 不拦截宿主压缩；自动摘要失败只保留 pending 标记 |
| SillyTavern #5976：`{{random}}` 嵌套后前导 `::` 产生空选项 | 宏引擎正则先吃掉前导 `::` 再切分 |
| flizzywine/dsh-tavern #318：重载后重新生成仍用旧卡快照 | 每轮冻结计划，资产修订下一轮生效，重新生成开新轮 |

## 三、建议但未改动（需要产品决定）

1. ~~**玩过的角色无法永久删除。**~~ 已修复（对应 Player-MINEPIG/dsh-tavern #22）：新增 `getCharacterDeletePlan` 预检，确认框列出全部剧情及绑定状态；`deleteCharacter` 带上用户确认的 `discardStoryIds`，锁内复扫后只删除无绑定且已确认的剧情，仍有绑定、损坏绑定或确认后新出现的剧情继续拒绝。测试：`test/characterDeleteStories.test.ts`、`test/assetEditorInteraction.test.tsx`。
2. **预设导入无损快照**（PURGE 研究 §2.7 P0）：导入时原样保存 ST 预设 JSON，并返回结构化丢失清单。
3. **纪律契约测试**（PURGE 研究 §2.2 P0）：把 `BOUND_DISCIPLINE` / `TURN_PLAYBOOK` 拆成契约句并逐字断言，改文案时同时递增 `STANDING_PIN_VERSION`。
4. **非 DeepSeek 通道的 `tavern:turn` 快照在历史里逐轮累积。** 宿主 `RuntimeContextProjection` 只在文本变化时追加新快照、不替换旧快照；每轮世界书命中与记忆检索不同，于是每轮都留下一份（世界书层默认上限 8192 token）。DeepSeek 官方通道的投影会剔除旧 `tavern:turn`（`presetRequestProjection.ts`），其它供应商没有。同类问题：flizzywine/dsh-tavern #33（脚手架占长会话 81% 上下文）、a86582751/dsh-nexttavern #17（60 轮后请求超限）。可选方案：每隔 N 轮用宿主 replacement surface 事件把更早的快照替换为一行占位（代价是该处前缀缓存失效一次）。
   - **已加诊断**：会话芯片的上下文用量下方显示「旧本轮快照 N 份、约 X token」，并区分「仍随每次请求发送」与「DeepSeek 通道发信前已剔除」（`src/node/turnContextDiagnostics.ts`，`getContextUsage.staleTurnContext`）。`test/staleTurnContext.test.ts` 用真实 AgentLoop 连跑三轮，确认第三轮发给普通供应商的请求里仍含前两轮快照正文。是否替换旧快照，待实际会话里看到累积量后再定。
5. 关闭 GitHub issue #13：0.5.4 已修复，作者已回复，但 issue 仍是 open。

## 四、同类插件做得更好的地方（功能面）

| 项目 | 值得借鉴 |
| --- | --- |
| flizzywine/dsh-tavern（★1190） | 正文、变量结算、候选项分步完成，哪步失败重来哪步；MVU 状态栏由固定模板渲染，不靠模型输出；「带意见重写」；剧本模式 / Guide 注入；对话式改卡与调试 Agent；Android 安装与扫码远程游玩；配图、卡片更新器等周边插件生态 |
| a86582751/dsh-nexttavern（★188） | 关键词 / 语义 / 混合三种历史召回，支持本地嵌入模型；导演笔记带来源哈希；多角色 Agent 推演；按任务分配模型路由；小说稿导出；模型用量与缓存统计面板；一键安装器 |
| Player-MINEPIG/dsh-tavern | 对外提供组装 API，供其它提示词插件组合使用 |

本插件的相对优势在状态一致性：剧情隔离、WAL 先于正文、分支先准备后发布、第三方脚本仅在 QuickJS/WASM 与 opaque iframe 中执行。上表多数功能可以在这套状态模型上增量实现，优先级建议：语义/混合检索（记忆召回质量）> 分步重试（降低整轮重来成本）> 用量统计面板。

## 参考

- SillyTavern：[#5941](https://github.com/SillyTavern/SillyTavern/issues/5941)、[#5976](https://github.com/SillyTavern/SillyTavern/issues/5976)、[#5894](https://github.com/SillyTavern/SillyTavern/issues/5894)、[#5864](https://github.com/SillyTavern/SillyTavern/issues/5864)
- dsh 酒馆插件：[flizzywine/dsh-tavern](https://github.com/flizzywine/dsh-tavern)、[a86582751/dsh-nexttavern](https://github.com/a86582751/dsh-nexttavern)、[chen731215-dev/dsh-tavern-v2](https://github.com/chen731215-dev/dsh-tavern-v2)、[Player-MINEPIG/dsh-tavern](https://github.com/Player-MINEPIG/dsh-tavern)
- 提示词注入：`docs/PURGE_INJECTION_STUDY.md`
