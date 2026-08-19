# dsh-tavern

English: [README.en.md](./README.en.md)

给 `dsh web` 用的角色扮演插件。导入 SillyTavern 角色卡、提示词预设、世界书、人设和正则，再加上长期记忆、世界状态，以及可回滚的楼层（重新生成 / 回退 / 编辑）。

和 SillyTavern 最大的差别在提示词怎么进模型。卡和书落成工作区文件，live 请求拆成稳定段 `tavern:standing` 和本轮 `tavern:turn`，不是每轮把整包设定塞进 system。模型缺设定再按条去读。

需要 dsh `0.1.0-rc.6`、Node 24。改代码看 [AGENTS.md](./AGENTS.md)。角色卡、记忆、会话绑定位于 `$DSH_HOME/dsh-tavern/`（Windows 一般是 `%USERPROFILE%\.dsh\dsh-tavern`）。

## 安装

```bash
dsh plugin add dsh-tavern
```

从源码开发：

```bash
# 把本仓库以包名挂进 dsh profile（Windows junction，不用管理员）
cmd //c "mklink /J %USERPROFILE%\.dsh\profiles\node_modules\dsh-tavern <本仓库>"

npm install
npm run build
npm run dev          # dsh web --patch ./cordis.dev.yml
```

`cordis.dev.yml` 按包名 `dsh-tavern` 挂载。改源码后重新 `npm run build`，再刷新页面。

## 用法

1. 设置 → Tavern → 角色卡，导入 PNG 或 JSON。有内嵌世界书会问要不要一起导入。
2. 会话顶部选 **Tavern 模式**（预设写在 `$DSH_HOME/.agent-presets/tavern/`，升级会覆盖，别手改）。
3. 点会话头的角色芯片绑卡，可选预设 / 人设 / 世界书，保存。
4. 新对话不会自动选卡。设置里的默认绑定只在你点选角色时套用。
5. 之后正常发消息。开场白可以插入，也可以 swipe。

角色选择只在 agent 预设为 `tavern` 时出现。还是普通助手的话，就是没切到 Tavern 模式。

## 功能

- **角色卡**：PNG（`tEXt` / `chara`，ccv3 优先）或 JSON，V1/V2/V3。内嵌世界书和正则随卡落盘。每卡一个工作区 `characters/<cardId>/`。界面显示 `card.name`，不是文件夹名。
- **预设**：Prompt Manager 语义。角色定义、启用骨架、常驻世界书进 standing；本轮关键词世界书和记忆进 turn。第三方预设如果没有 `agentMemory` / `worldState` 这两个 marker，运行期会在 `chatHistory` 前补上。
- **世界书**：明文/正则键、selective、递归、sticky/cooldown/delay、预算、七种插入位置。没命中的条目用 `tavern_lore_read` 按条读，不整本倒。
- **正则**：input/output/prompt × assemble/send/render。卡内展示向默认开；预设里的脚本跟自己的 `disabled` 走。
- **记忆**：BM25 + 时间衰减，写入去重，超容量在空闲时压缩。面板里可查看 / 编辑 / 删除。
- **世界状态**：add / update / invalidate，当世界书的变化层。可单条撤销，可导出成新的世界书 JSON，不改原书。
- **楼层**：重新生成、编辑用户消息、回退。dsh 不能删日志，所以会 fork 出分支会话，WAL 回滚记忆和世界状态。

## 提示词怎么进模型

`assemblePrompt` 仍按 ST 算出完整序列，给「预览提示词」用。真正发给模型时是两条通道：

| 通道 | 落点 | 内容 | 稳定性 |
| --- | --- | --- | --- |
| standing | system 段 `tavern:standing`（order 210，工具说明后面） | 扮演纪律、角色定义、预设骨架、常驻世界书 | 绑定不变则按会话钉死 |
| turn | runtime context `tavern:turn` | 本步 playbook、关键词世界书、记忆、变化层、作者注释、本轮宏 | 每步都会变 |
| messages | 只在预览里 | 完整 ST 序列，含 @D 插位 | live 插不进会话日志中间 |

`{{setvar}}` / `{{getvar}}` 组装前展开。时钟在 standing 里冻结。排查以芯片面板的预览为准。

## 兼容（SillyTavern → 本插件）

| ST 字段 / 特性 | 情况 |
| --- | --- |
| V2 核心字段（description / personality / scenario / first_mes / alternate_greetings / mes_example / system_prompt / post_history_instructions） | 全量参与组装 |
| creator_notes / tags / creator / character_version | 只展示 |
| character_book | 随卡导入 |
| regex_scripts | 卡内导入（展示向默认开，prompt/input 默认关）；预设内跟 `disabled` |
| 世界书 entries（含 selectiveLogic / sticky / cooldown / delay / probability / group / automation_id） | 引擎已实现；group / automation_id 保留不消费 |
| 向量匹配 | 不做，语义召回走记忆层 BM25 |
| 预设 prompt_order / 条目字段 | 支持 |
| `{{char}}` / `{{user}}` / `{{outlet}}` / `{{trim}}` / `{{time}}` 等 | 组装时展开 |
| `{{setvar}}` / `{{getvar}}` / `{{//}}` | 组装内预处理。不落盘，没有 if / dice / STscript |
| temperature / maxTokens / stop | 透传 |
| top_p / presence_penalty / frequency_penalty | 平台送不到模型，面板里仅记录 |

## 平台限制

这些是宿主限制，改插件绕不开。

1. 能送到模型的只有 `temperature`、`maxTokens`、`stop`，以及模型公布的 `reasoningEffort`。深度思考关掉写成 `off`。部署若把 `llm-deepseek.thinking` 锁成 `disabled`，插件打不开。thinking 模式下温度可能被模型忽略。
2. 会话日志不能往中间插。@D 和作者注释在实际请求里并进 system 尾部。完整插位只在预览里。
3. 重新生成 / 回退 / 编辑会开分支：fork 前缀 + WAL 回滚 + 子会话续跑。fork 失败不会先改源工作区。
4. 操作条只在 assistant 消息上。「编辑用户消息」挂在助手楼层。
5. 同一张卡多个会话一起写会交错，工作区和 WAL 以卡为单位。别这么干。
6. host→client 事件白名单是静态的，自定义事件推不到 UI，操作后自己刷新。

## 交互卡

部分卡内嵌 HTML/JS。渲染在 `sandbox="allow-scripts"` 的 iframe 里，没有 `allow-same-origin`。CSP：`default-src 'none'`，内联脚本/样式，默认允许 https/http 图片和字体。脚本 fetch 和外部脚本默认禁止，设置里的域名白名单会放宽 `connect-src` / `script-src`（一行 `*` 表示全放）。

卡内可通过注入的 ST / JS-Slash-Runner stub，用 `postMessage` 请求宿主 `swipeGreeting`。没有通用主窗口桥。设置里有总开关，关掉按纯文本显示。

卡里的脚本是第三方代码，只导入你信得过的来源。

## 调试

会话头芯片里有触发日志和预览提示词。工作区 `state/wal/` 按楼层留写入前快照，回滚过的目录会改名为 `.rolled-back-<时间戳>`。

## 开发

```bash
npm run build
npm test
```

`src/core/` 纯函数，`src/state/` 文件存储，`src/node/` host，`src/agent.ts` agent 面，`src/client/` UI，`src/remote.ts` 契约。`lib/` 是交付物，会进 git。改了 `src/` 必须重新 build。
