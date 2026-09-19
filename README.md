<div align="center">

# dsh-liketavern

**在 DeepSeek Harness 的 `dsh web` 中使用角色卡、世界书与长期记忆，开始 Tavern 式角色扮演。**

**[v0.3.0](https://github.com/Amakurai/dsh-liketavern/releases/tag/v0.3.0) · 适配 dsh `0.1.5-rc.2` · Node.js ≥ 24**

中文 | [English](./README.en.md)

[功能](#功能) · [安装](#安装) · [开始使用](#开始使用) · [日常使用](#日常使用) · [兼容范围](#兼容范围)

[数据与备份](#数据与备份) · [常见问题](#常见问题) · [文档](#文档) · [开发](#开发) · [参与贡献](#参与贡献)

</div>

dsh-liketavern 是 DeepSeek Harness 的角色扮演插件。你可以导入 SillyTavern（下文简称 ST）角色卡和提示词预设，在 dsh 中管理设定、推进剧情、重新生成和切换分支。模型连接、聊天历史和 agent 运行时由 dsh 提供，插件负责角色资产、提示词组装和剧情状态；界面默认跟随宿主语言。

内置 EJS 提示词模板、酒馆助手部分接口和可选原生 MVU。第三方卡片能否直接使用，取决于其依赖的接口；具体范围见下方[兼容说明](#兼容范围)。

第一次使用可从[安装](#安装)和[第一段对话](#开始使用)开始；迁移已有 ST 资产时，先核对[基本概念](#基本概念)和[兼容范围](#兼容范围)；开发与适配入口在[文档](#文档)。

## 功能

| 功能 | 当前能力 |
| --- | --- |
| 角色卡 | 导入 V1 / V2 / V3 的 PNG、JSON 角色卡，导出 PNG / JSON；支持可恢复的收纳箱与引用保护永久删除；多开场白、内嵌世界书、卡内正则与 HTML 交互卡 |
| 预设与人设 | 导入、编辑和导出 ST 提示词预设；人设提供 `{{user}}` 名称和描述；预设与人设在读写入口校验数据 |
| 世界书与世界状态 | 全局、角色、会话级世界书；关键词触发、常驻条目；剧情变化层记录新增、变更和失效的事实 |
| 长期记忆 | BM25 检索与时间衰减，模型按需读写；超过容量时在空闲阶段自动摘要，保留可检索的归档来源 |
| 剧情分支 | 重新生成、编辑和回退创建独立子会话，撤销受影响的记忆、变量等剧情状态，保留原会话 |
| EJS 模板 | 条件、循环、异步表达式、剧情及消息变量、JSON / YAML 初值、JSON Patch、Zod、Lodash、Faker 与世界书装饰器 |
| 交互卡与脚本 | 沙箱卡面、三类脚本库、剧情变量持久化、同页面同剧情事件、世界书读写、消息编辑 / 删除 / swipe 与显示刷新 |
| 原生 MVU | 可选自动初始化与正常回复后的变量更新，失败任务保留重试；受限适配角色展示正则声明的状态栏占位符 |
| 代答与续写 | AI 代答生成用户台词并复制到剪贴板；续写沿当前会话继续生成 |

模型可按需调用 7 个工具：记忆检索 / 写入 / 更新、世界书按条读取、世界状态更新、资产列表 / 读取。普通扮演直接回复，缺少设定或需要记录已确定事实时再使用工具。

编辑器支持未保存提示和草稿恢复；设置页、表单和弹窗适配窄屏。第三方交互卡内部是否适配手机，仍由卡片自身排版决定。

角色管理页、收纳箱和新会话角色选择器支持按角色名、标签、作者或内嵌世界书名搜索。

### 基本概念

| 名称 | 用途与区别 |
| --- | --- |
| Tavern 模式 | dsh 的会话预设，负责启用插件的角色扮演运行时；新建会话时选择 |
| 提示词预设 | 在 Tavern「预设」页管理的 ST 提示词配置；绑定到角色会话后使用，可先用内建默认值 |
| 角色卡 / 人设 | 角色卡描述 AI 扮演的角色；人设描述你在故事中的身份，并提供 `{{user}}` 的名字 |
| 世界书 / 记忆 / 世界状态 | 世界书提供背景设定；记忆记录剧情事实；世界状态记录设定在剧情中的新增、变更与失效 |
| 会话 / 剧情 / 分支 | 会话保存聊天记录，绑定的剧情保存插件状态；重新生成等操作会创建子会话及独立剧情 |
| MVU | 卡片常用的变量更新框架；本插件提供可选原生执行器，供依赖变量更新的卡使用 |

## 安装

### 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | 24 或更新版本；当前开发与 Windows / Ubuntu CI 使用 Node 24 |
| dsh CLI / 宿主 | **`0.1.5-rc.2`**，本插件的宿主依赖锁定此版本 |
| pnpm | 已安装且可在终端运行，供 `dsh plugin` 管理插件依赖 |
| 模型 | 在 dsh 中完成模型配置，能够正常对话 |

首次使用 dsh 可先参考[官方文档](https://deepseek-harness.github.io/deepseek-harness/)，运行一次 `dsh web` 完成配置。`web` profile 会在首次启动或安装插件时自动初始化。

### 安装正式版本

在终端执行，固定到发布标签：

```bash
dsh plugin --profile web add github:Amakurai/dsh-liketavern#v0.3.0
dsh plugin --profile web list --depth 0
```

确认列表中出现 `dsh-liketavern` 后，停止已运行的 dsh，再启动：

```bash
dsh web
```

本仓库包含编译好的 `lib/`，普通安装无需自行构建。插件会作为组合包自动加入 `web` profile；安装机制见官方[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)。

### 使用安装包

从 [v0.3.0 Release](https://github.com/Amakurai/dsh-liketavern/releases/tag/v0.3.0) 下载 `dsh-liketavern-0.3.0.tgz`，在文件所在目录执行：

```bash
dsh plugin --profile web add ./dsh-liketavern-0.3.0.tgz
```

安装后同样重启 `dsh web`。Release 附有 `SHA256SUMS.txt`，可用于核对下载文件。

### 升级

在「设置 → Tavern → 关于」可查看插件和宿主版本、打开 GitHub 项目，并点击「检查更新」查询最新正式发布。页面会核对宿主版本；发现兼容的新版本后可复制固定发布标签的更新命令。当前宿主通过终端安装更新，检查按钮不会自动安装。源码开发版会提示在源码目录更新并构建。自定义 profile 需将命令中的 `web` 改为对应名称。

先核对[更新日志](./CHANGELOG.md)中的宿主版本，停止 dsh 并备份数据，再执行目标版本的安装命令。升级插件沿用现有数据目录；完整备份范围见[数据与备份](#数据与备份)。

未带 `#版本标签` 的 GitHub 地址跟随仓库默认分支。希望固定运行内容时，使用正式标签或具体 commit。升级 dsh 宿主前，也需要确认有对应的插件版本。

## 开始使用

先完成 dsh 的模型配置，再用一张角色卡跑通普通对话。提示词预设可使用内建默认值，人设、附加世界书、脚本和 MVU 按卡片需要再配置。

1. **准备角色卡。** 在 dsh 设置中的「Tavern → 角色」页导入 PNG / JSON，或创建角色。导入前会显示兼容报告，再选择是否接收内嵌世界书；取消检查不会保存角色。报告静态检查已知接口、脚本、模板和外部资源，不执行代码，也不保证任意第三方卡兼容。
2. **新建剧情。** 新建会话，选择「Tavern 模式」，再点选角色卡。新会话不会自动绑定默认角色；空列表中的「导入 / 创建角色」也可打开管理页。
3. **确认设定。** 点击会话顶部的角色入口，为当前会话选择提示词预设、人设和世界书并保存；暂时没有附加资产时可保留默认配置。
4. **开始对话。** 有多条开场白时用左右按钮切换，再点「开始对话」并发送第一条台词；没有开场白的卡可直接输入。
5. **继续或修改剧情。** 使用 AI 回复旁的操作条进行重新生成、编辑、回退、续写或 AI 代答；同一楼层的分支可用 `‹ n/m ›` 切换。

收到第一条正常回复后，可从会话顶部角色入口打开「提示词预览 → 最近请求」，查看本轮实际捕获的请求。脚本卡的后续配置见[脚本与原生 MVU](#脚本与原生-mvu)。

## 日常使用

### 配置入口与生效范围

下表中的「Tavern」指 dsh 设置里的 Tavern 管理页。

| 想做什么 | 入口 | 生效范围 |
| --- | --- | --- |
| 管理角色卡、提示词预设、世界书和人设 | Tavern → 角色 / 预设 / 世界书 / 用户 | 共享资产；用于这些资产的后续提示词组装 |
| 设置以后选卡时的默认组合 | Tavern → 设置 → 默认配置 | 之后在新会话中点选角色时套用，已绑定会话单独调整 |
| 调整当前会话的预设、人设、世界书与作者注释 | 会话顶部角色入口 | 当前会话，保存后用于后续轮次 |
| 编写只属于这条剧情的世界书 | 会话顶部角色入口 → 编辑本会话世界书 | 当前剧情，随分支继承和回滚 |
| 查看或修订记忆、世界状态、角色笔记 | 会话顶部角色入口 → 记忆；或 Tavern → 记忆 | 当前 / 所选剧情；选择「初始状态」则只影响未来新剧情 |
| 管理正则、脚本与变量备份 | Tavern → 正则；Tavern → 设置 → 脚本 / 卡片与数据 | 正则和脚本按所选来源管理，变量备份按角色与剧情选择 |
| 检查提示词与世界书触发情况 | 会话顶部角色入口 → 提示词预览 | 当前会话，只读查看 |

提示词在每轮首次成功组装后固定；生成中编辑资产或设置，会在下一轮使用。界面语言默认跟随宿主（中文宿主显示中文，其余显示英文），也可在「Tavern → 设置 → 界面 → 界面语言」固定为中文或 English；语言选择立即保存，仅影响插件界面。

### 脚本与原生 MVU

1. 在「Tavern → 设置 → 脚本」选择全局、预设或角色脚本库，检查脚本及所在文件夹是否启用，并保存修改。
2. 需要自动 MVU 的卡，在会话顶部角色配置中勾选「启用原生 MVU 自动更新」并保存。普通对话可不启用。
3. 保持对应会话页面打开，在脚本页查看运行状态及错误。失败或断开的更新会保留为待处理任务；接口支持情况见[酒馆助手兼容说明](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/TAVERN_HELPER.md)。

### 修改剧情时会发生什么

例如，原会话中已经记录「角色取得钥匙」，你回到取得钥匙之前重新生成：插件会创建独立子会话，在子剧情中撤销未继承楼层的记忆、变量等状态，原会话仍保留原来的发展。两条剧情此后独立演进，共享的角色卡和预设仍可复用。

编辑 AI 正文也会创建分支，并撤销该层及后续派生事实；保存编辑后，由你接话或手动修订状态。续写则沿当前会话继续生成。更详细的边界见[提示词、采样和楼层操作](#提示词采样和楼层操作)。

## 兼容范围

### 第三方卡片、模板和脚本

- **酒馆助手提供部分兼容接口。** 支持变量、脚本库、世界书与多种消息操作；`generate` / `generateRaw`、消息插入与旋转、历史分页和跨页面事件等仍待适配。完整接口和示例见[酒馆助手兼容说明](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/TAVERN_HELPER.md)。
- **EJS 模板已内置。** 使用已支持接口的卡无需另装 ST-Prompt-Template；提示词位置、历史处理等宿主差异见[提示词模板说明](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/PROMPT_TEMPLATES.md)。
- **消息格式化已更换为 markdown-it。** 已移除有漏洞的 Showdown，保留常用展示语法；旧回复快照不重算。升级前请备份并完成旧模板生成、让跨轮回调结束；仍含旧重放日志时会明确拒绝继续执行，保留数据供完成或回滚。格式差异和处理步骤见上述模板说明。
- **MVU 支持有边界。** 纯官方 MVU 导入入口可适配到原生执行器，自定义框架保持原代码；classic schema 与 `BEFORE_MESSAGE_UPDATE` 正文更新钩子仍待适配。当前界面没有独立的变量 schema 编辑器入口。
- **交互卡在隔离 iframe 中运行。** 不提供主页面 DOM、`parent.TavernHelper`、`parent.$` 或 Node 访问。网络请求及外部脚本默认受限，可在「设置 → 卡片与数据」配置可信域名；图片和字体按现有策略加载。
- **脚本选项不会自动发送。** 后台脚本发布的文字选项由用户点击后填入当前输入草稿；AI 代答目前仍使用剪贴板，需要手动粘贴。

### 提示词、采样和楼层操作

| 项目 | 实际行为 |
| --- | --- |
| 采样参数 | 导入预设保留受支持的采样字段，并按字段覆盖插件设置，未提供的沿用插件设置；旧预设需重新导入以补回以前未保存的参数。`temperature`、`maxTokens`、`stop` 及插件设置中模型公布的思考档位可以生效；`top_p`、惩罚系数仅记录并提示。宿主锁定关闭思考时，插件不能强制开启 |
| 提示词预览 | 「最近请求」在官方 DeepSeek 通道显示布局与系统能力处理后的消息及兼容说明；其它通道显示宿主请求。其他页签是重新计算的 ST 模拟，不能代表实际入模消息 |
| 预设语义 | 卡级主提示词与后置指令替换原槽位，遵守开关、触发场景及禁止覆盖设置；「设置 → 提示词」可分别关闭这两种角色覆盖。仅通过 `{{original}}` 保留原文。动态宏变量的后续读取进入本轮上下文，静态变量仍可使用稳定前缀 |
| 预设格式与宏 | 保留 `wi_format`、`scenario_format`、`personality_format`；空格式发送原字段，旧预设需重新导入原 JSON 补回格式。`lastmessage` 读取最后一条真实用户或角色消息，`charPrompt` / `charInstruction` 读取卡片提示字段。导出内建标记 `system_prompt` 与消息角色独立，自定义 system 条目可往返 |
| 预设消息位置 | DeepSeek 官方通道自动使用 Tavern 适配器按角色、顺序与深度插入预设。支持途中更新 system 的模型使用完整系统快照；只读首条 system 的模型将系统条目合并到首条，user/assistant 保留位置。继续使用原宿主聊天、工具、凭证及流式回复；每轮冻结布局，不替换历史正文。其他供应商暂沿用 standing/turn 两段映射 |
| 正则与助手预填 | 实时展示使用 `output/render`；历史正则改写用于模拟与代答。末尾 assistant 条目按普通 assistant 消息发送，尚未实现供应商专用 prefill/prefix 协议；不能据此保证模型从该文本继续生成 |
| 改写与删除 | 楼层编辑、回退、重新生成及脚本消息删除通过分支实现，原会话保留。编辑 AI 正文会撤销该层及后续派生事实，不自动重新提取或发起回复 |
| 回滚范围 | 回滚覆盖插件剧情状态；剧情工作区之外的工具副作用不会随楼层操作撤销 |

<details>
<summary>工具调用与自建宿主：PTC 要求</summary>

Tavern 使用 dsh 原生 PTC（程序化工具调用）。需要查证或记事时，模型可用一次 `run_code` 合并操作，独立查询可并行，只回传必要结果。写入仍经当前剧情的楼层事务。更新后重启 dsh，以加载插件托管的 Tavern 预设；自建宿主需提供 `codeRuntime`，与原装 PTC 模式要求相同。

</details>

## 数据与备份

### 数据位置与隔离

插件数据位于 `$DSH_HOME/dsh-tavern/`。未设置 `DSH_HOME` 时，默认是 `~/.dsh/dsh-tavern/`（Windows 为 `%USERPROFILE%\.dsh\dsh-tavern\`）。宿主聊天记录与配置还保存在 dsh 的其他目录；完整迁移或升级备份应在停止 dsh 后复制整个 `DSH_HOME`。

**角色资产共享，剧情状态隔离。** 同一角色的卡片、预设和脚本资产可复用；每个剧情及分支独立保存记忆、世界变化、笔记、聊天世界书、变量和回滚日志。新剧情复制角色初始状态，修改「初始状态」只影响之后创建的剧情。同一数据目录不支持多个宿主进程同时写入。

### 选择备份方式

| 保存方式 | 包含什么 | 如何恢复 / 注意事项 |
| --- | --- | --- |
| 交互卡变量备份 | 已保存的当前剧情变量，变量数据最多 1 MiB | 「设置 → 卡片与数据」选择角色与剧情，导出或粘贴备份恢复；不包含消息正文、角色卡、脚本资产或尚未写入变量的表单输入 |
| 编辑草稿暂存 | 角色、预设、世界书、用户、正则、记忆和设置的未保存编辑 | 出现「草稿已暂存」后，在同一浏览器标签页刷新或重开编辑器可恢复；仍需点保存才能应用。单份上限 2 MiB |
| 可校验目录备份 | `DSH_HOME` 内插件数据、宿主会话与配置；含版本、文件大小及 SHA-256 清单 | 用下方命令创建、校验、恢复到新目录；排除可重装的 profile 依赖，变量导出不能替代此备份 |

编辑草稿保存在插件数据目录的 `editor-drafts/`，浏览器只保存随机标签页标识。关闭标签页或禁用浏览器存储后不保证恢复；暂存失败会保留页面内容并提供重试，明确放弃会清除对应草稿。角色预览中的交互数据是临时的，不会写入真实剧情。

### 迁移与恢复

在插件源码或安装目录中使用以下命令，把示例路径替换为实际路径。备份和恢复的目标必须不存在，其父目录必须已存在。

```sh
node lib/backup.js create --home "C:/data/dsh-home" --backup "D:/backups/dsh-2026-09-19" --offline
node lib/backup.js verify --backup "D:/backups/dsh-2026-09-19"
node lib/backup.js restore --backup "D:/backups/dsh-2026-09-19" --target "C:/data/dsh-restored" --offline
```

安装环境已暴露命令时，也可将 `node lib/backup.js` 换成 `dsh-tavern-backup`。加 `--json` 可读取结构化结果。校验会拒绝缺失、篡改和额外文件，并检查插件数据结构、绑定引用和 WAL；恢复先验证并在临时目录复制，成功后才发布新目录，不覆盖现有数据。宿主压缩历史按字节校验，不做完整语义解析，恢复后仍需实际打开会话检查。

1. 停止所有使用该数据目录的 dsh 进程，再创建备份。`--offline` 是操作者的停机声明；工具可拒绝仍活跃的 PID 锁，但无法证明所有写入进程均已停止。
2. 恢复到单独目录，核对保留的 profile 配置与锁文件，安装对应的 dsh / 插件版本，并让 `DSH_HOME` 指向恢复目录；保留原备份。清单记录执行备份工具时的版本，不能证明数据最后由哪个历史版本写入。
3. 核对角色、会话、分支、记忆与已保存变量，再按目标版本的升级说明继续。

备份保留 profile 配置和锁文件，精确排除 `profiles/node_modules`、`profiles/<名称>/node_modules` 与 `profiles/<名称>/.dsh-module-fallback/node_modules`；恢复后需按原 profile 重装依赖。其余位置的符号链接、junction、硬链接与异常文件会被拒绝，不跟随到目录外。自定义放在 `DSH_HOME` 外的插件数据、外部工作区及外部凭据需另行备份。目录备份没有加密，可能包含本地凭据和私有对话，应按原数据同等保护。

旧版共享状态会在首次打开旧绑定时复制到独立剧情，原目录保留。此前混合的多分支事实无法自动可靠拆分，需要核对迁移结果。自动摘要可能遗漏信息，原文来源会保留；异常、截断或超时回复不会触发归档。分支与归档会占用磁盘，当前不自动清理旧剧情。

## 常见问题

| 问题 | 排查方式 |
| --- | --- |
| 安装后没有 Tavern 模式或设置入口 | 用 `dsh --version` 确认宿主为 `0.1.5-rc.2`，再用 `dsh plugin --profile web list --depth 0` 检查安装目标；重启 `dsh web` 后新建会话，仍未出现时查看终端的插件加载错误 |
| 改了默认预设，当前对话没有变化 | 默认配置只在新会话点选角色时套用；当前对话在会话顶部角色入口修改并保存 |
| 卡片显示正常，但按钮、脚本或 MVU 不工作 | 检查交互卡是否启用，再到「设置 → 脚本」确认脚本及文件夹已启用并保存，查看运行诊断；自动 MVU 还需开启会话选项并保持页面打开，按[兼容范围](#兼容范围)核对所需接口 |
| 记忆页为空，或修改没有作用于当前剧情 | 检查所选角色、剧情及是否选中了「初始状态」；长期记忆由模型工具或手动写入，对话正文不会逐条自动复制到记忆中 |
| 提示词预览与模型表现不一致 | 先查看「最近请求」及兼容说明；其他页签是 ST 模拟。新会话尚未发出请求、宿主重启或缓存淘汰后，最近请求可能为空 |
| pnpm 提示构建脚本被拦截 | 先核对报错涉及的依赖；插件源码构建问题可尝试 Release 安装包，宿主依赖按 dsh 提示检查对应 profile 的 `pnpm-workspace.yaml` 中的 `allowBuilds` |

### 只读诊断

安装环境可运行：

```bash
dsh plugin --profile web exec dsh-tavern-doctor
dsh plugin --profile web exec dsh-tavern-doctor --json
```

源码仓库中对应 `npm run doctor` 和 `npm run doctor -- --json`。报告只给出版本、目录状态、角色/剧情/WAL（回滚日志）数量和固定问题码，不输出真实路径、资产名称、ID、正文或令牌，也不提供修复参数。

仍无法定位时，可按[问题反馈](#问题反馈)提供最小复现。

## 文档

| 你要了解什么 | 文档 |
| --- | --- |
| 版本变化、升级时的宿主要求 | [更新日志](./CHANGELOG.md) |
| 卡面、脚本、变量、世界书、消息和 MVU 接口 | [酒馆助手兼容说明](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/TAVERN_HELPER.md) |
| EJS、宏、装饰器与模板示例 | [提示词模板说明](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/PROMPT_TEMPLATES.md) |
| 第三方接口的适配进度与验收条件 | [酒馆助手适配进度](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/TAVERN_HELPER_INTEGRATION.md)、[ST 模板兼容核对](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/ST_COMPATIBILITY_AUDIT.md) |
| 剧情隔离、分支回滚、记忆和提示词通道 | [架构说明](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/ARCHITECTURE.md) |
| 已核对的宿主行为、UI 冒烟范围及升级检查 | [宿主兼容记录](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/HOST_COMPATIBILITY.md) |
| 依赖安全更新、剩余告警与隔离边界 | [依赖安全记录](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/DEPENDENCY_SECURITY.md) |
| 代码边界、测试、发布包与交付要求 | [开发约定](https://github.com/Amakurai/dsh-liketavern/blob/main/AGENTS.md)、[发布包审核](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/RELEASING.md) |

## 开发

### 环境与验证

开发栈为 TypeScript ESM（NodeNext）、React 和 Vitest。先克隆本仓库并进入目录；当前宿主包版本以 `package.json` 为准。

在 Node 24 下，从仓库根目录执行：

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

`lib/` 是提交到 Git 的交付物，修改 `src/` 后必须重新构建并同步提交。`npm pack` 会先构建；发布包仅包含编译产物、插件配置、预设及发布说明文件。测试使用手写工厂数据，不提交真实卡片、会话或记忆。

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 通过仓库的 `cordis.patch.yml` 启动本地 dsh web，需先完成下方挂载 |
| `npm run doctor` | 只读检查当前 `DSH_HOME`，不修复数据 |
| `npm run doctor:check` | 在临时环境验证编译后的诊断入口、安装链接和 JSON 输出 |
| `npm run package:check` | 检查打包白名单、必要产物与发布文档的相对链接；需先构建 |

CI 在 Ubuntu 与 Windows 上执行构建、测试、诊断入口和打包检查，并在 Ubuntu 检查 `lib/` 与提交一致。宿主升级还需完成安装环境的启动与 UI 冒烟，核对步骤见[宿主兼容记录](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/HOST_COMPATIBILITY.md)。

### 本地挂载与调试

<details>
<summary>展开 Windows / macOS / Linux 挂载示例</summary>

先运行一次 `dsh web` 初始化 profile，再把仓库挂载到 `$DSH_HOME/profiles/node_modules/dsh-liketavern`。以下示例使用默认的 `~/.dsh`；自定义 `DSH_HOME` 时请替换路径。使用专用开发数据目录，避免已安装的发行包遮蔽本地挂载。

```powershell
# Windows（PowerShell，在仓库根目录执行）
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\profiles\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-liketavern" -Target (Get-Location).Path
```

```bash
# macOS / Linux（在仓库根目录执行）
mkdir -p ~/.dsh/profiles/node_modules
ln -s "$(pwd)" ~/.dsh/profiles/node_modules/dsh-liketavern
```

挂载完成后执行 `npm run dev`，会以 `dsh web --patch ./cordis.patch.yml` 启动。代码变更后先运行 `npm run build`，再重启开发实例验证。

</details>

### 仓库结构

```text
src/
├── core/     纯函数：提示词、世界书、正则、宏、BM25、兼容数据处理
├── state/    文件存储：角色资产、剧情工作区、记忆与回滚日志
├── node/     宿主编排：配置、服务、管线、楼层、工具与维护
├── client/   React 界面：管理页、会话操作、交互卡与脚本运行器
├── index.ts  宿主入口
├── agent.ts  agent 入口
└── remote.ts 前后端业务契约
```

`test/` 保存行为与集成测试，`scripts/` 保存构建和交付检查，`presets/` 保存 Tavern 宿主预设，`docs/` 保存专题说明，`lib/` 保存发布产物。

## 参与贡献

### 问题反馈

在 [GitHub Issues](https://github.com/Amakurai/dsh-liketavern/issues) 提交问题时，请包含：

- 插件、dsh、Node.js 版本，操作系统、浏览器与安装方式。
- 从哪个页面执行了哪些步骤、预期结果和实际结果，以及相关错误或只读诊断结果。
- 去除私人内容的最小复现；第三方卡片问题请说明依赖的脚本或接口，可用手写测试卡复现。

涉及提示词问题时，请说明依据的是「最近请求」还是 ST 模拟；提交截图或日志前移除密钥、私人剧情与个人信息。

### 代码与文档

修正文案、补充翻译、提供最小复现和接口适配都欢迎提交 PR。较大的功能或兼容性调整，建议先在 Issue 中说明使用场景与预期行为。

开始前阅读[开发约定](https://github.com/Amakurai/dsh-liketavern/blob/main/AGENTS.md)。修改 core/state 时补行为测试，涉及宿主事件、分支、请求或故障时补集成测试；修改源码后同步构建产物。README 的使用说明保持中英文同步，PR 中写明改动原因和实际完成的验证。

## License

[MIT](./LICENSE)
