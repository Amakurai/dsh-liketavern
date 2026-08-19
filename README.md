# dsh-liketarven

English: [README.en.md](./README.en.md)

dsh 插件。把 `dsh web` 做成 SillyTavern 式的角色扮演前端：角色卡、提示词预设、世界书、人设、正则，再加上 BM25 长期记忆、世界状态变化层，以及可回滚的楼层（重新生成 / 回退 / 编辑）。全部走 dsh 的 agent 运行时，不另开一条发信通道。

需要 dsh `0.1.0-rc.6`（`@deepseek-ai/*` 同版本）、Node 24。运行数据在 `$DSH_HOME/dsh-tavern/`。

## 和 SillyTavern 的差别

1. **资产是文件**。导入的卡、书、预设落在工作区里，agent 按需按条读，不把整本设定每轮塞进 system。
2. **多步循环**。一轮回复可以检索、写记忆、改世界状态，最后一步才出正文。默认仍是直接扮演。
3. **楼层可回滚**。某一层触发的记忆 / 世界状态 / 定时器写入记 WAL，回退逆序回放。dsh 不能删会话日志，所以楼层操作会 fork 出子会话。
4. **提示词走 dsh 瀑布**。稳定段 `tavern:standing` + 本轮 runtime context `tavern:turn`，不用 `complete` 段盖掉工具前缀，也不在前端拼包直发。

## 结构

TypeScript ESM，cordis 插件，分三面：

| 面 | 入口 | 做什么 |
| --- | --- | --- |
| host | `src/index.ts` | 设置命名空间、数据目录、agent 预设、`TavernService`、typert remote、楼层 WAL |
| agent | `src/agent.ts` | 组装 standing / turn、采样与 `reasoningEffort`、7 个模型工具、空闲时记忆压缩 |
| client | `src/client/` | 设置面板、会话头芯片、新会话英雄区、助手操作条和排版 |

host 和 client 的契约在 `src/remote.ts`。运行时依赖只有 `zod`，其余 `@deepseek-ai/*` 由 dsh 宿主提供。

```
src/
├── core/     纯函数：组装、世界书、正则、宏、BM25、钉死 standing
├── state/    文件存储（卡 / 书 / 预设 / 记忆 / WAL / 工作区）
├── node/     host 编排
├── client/   React UI
├── agent.ts  agent 面
└── remote.ts typert 契约
```

## 能力

- **角色卡**：PNG（`tEXt` / `chara`，ccv3 优先）或 JSON，V1/V2/V3。内嵌世界书和正则随卡落盘。每卡一个工作区，界面用 `card.name`。
- **预设**：Prompt Manager 语义。角色定义、启用骨架、常驻世界书进 standing；关键词世界书和记忆进 turn。缺 `agentMemory` / `worldState` marker 时运行期会补一层。
- **世界书**：明文/正则键、selective、递归、sticky/cooldown/delay、概率、预算、七种插入位置。未命中条目用 `tavern_lore_read` 按条读。
- **正则**：input/output/prompt × assemble/send/render。卡内展示向默认开，预设脚本跟自己的 `disabled` 走。
- **记忆**：BM25 + 时间衰减，写入去重，超容量在 idle 时压缩最旧批次。
- **世界状态**：add / update / invalidate，当世界书的变化层。可单条撤销，可导出成新书，不改原书。
- **楼层**：重新生成、编辑用户消息、回退。fork 前缀 + WAL 回滚 + 子会话续跑。
- **封面**：output/render 正则抽出的 HTML 在 `sandbox="allow-scripts"` iframe 里画，CSP 默认禁外部脚本和 fetch。

## 提示词通道

`assemblePrompt` 仍按 ST 算出完整序列，给预览用。真正发给模型是两条 dsh 通道：

| 通道 | 落点 | 内容 | 稳定性 |
| --- | --- | --- | --- |
| standing | system 段 `tavern:standing`（order 210，工具说明后面） | 扮演纪律、角色定义、预设骨架、常驻世界书 | 绑定不变则按会话钉死 |
| turn | runtime context `tavern:turn` | 本步 playbook、关键词世界书、记忆、变化层、作者注释、本轮宏 | 每步都会变 |
| messages | 只在预览里 | 完整 ST 序列，含 @D 插位 | live 插不进会话日志中间 |

`{{setvar}}` / `{{getvar}}` 组装前展开。时钟在 standing 里冻结。世界书和记忆每 turn 评估一次，step>1 仍重放本轮快照。

模型工具（默认不调用）：`tavern_memory_search` / `write` / `update`、`tavern_lore_read`、`tavern_worldstate_update`、`tavern_asset_list` / `read`。

## 兼容

| ST | 本插件 |
| --- | --- |
| V2 核心字段（description / personality / scenario / first_mes / alternate_greetings / mes_example / system_prompt / post_history_instructions） | 参与组装 |
| creator_notes / tags / creator / character_version | 只展示 |
| character_book、regex_scripts、世界书 entries | 导入并实现引擎；group / automation_id 保留不消费 |
| 向量匹配 | 不做，语义召回走记忆层 BM25 |
| `{{char}}` / `{{user}}` / `{{outlet}}` / `{{trim}}` / `{{time}}` 等 | 组装时展开 |
| `{{setvar}}` / `{{getvar}}` / `{{//}}` | 组装内预处理，不落盘，没有 if / dice / STscript |
| temperature / maxTokens / stop / reasoningEffort | 透传（思考关 → `off`） |
| top_p / presence_penalty / frequency_penalty | 平台送不到模型 |

宿主还限制：会话日志不能往中间插，所以 @D 和作者注释在 live 请求里并进 system 尾部；楼层操作只能 fork，不能改原日志；同一张卡多个会话并发写会交错。

## 安装

`lib/` 已入库，从 GitHub 安装不必授权构建脚本。

```bash
dsh plugin --profile web add github:Amakurai/dsh-liketarven
```

从源码开发：

```bash
cmd //c "mklink /J %USERPROFILE%\.dsh\profiles\node_modules\dsh-liketarven <本仓库>"
npm install
npm run build
npm run dev          # dsh web --patch ./cordis.dev.yml
```

`npm test` 直接跑 `src/`，不必先构建。改 `src/` 后重新 `npm run build`。
