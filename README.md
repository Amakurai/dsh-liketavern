<div align="center">

# dsh-liketavern

**DeepSeek Harness（dsh）插件 —— 把 `dsh web` 变成 SillyTavern 式的角色扮演前端**

**适配宿主版本：dsh `0.1.2-rc.1`**

中文 | [English](./README.en.md)

[功能](#功能) • [安装](#安装) • [使用](#使用) • [平台限制](#平台限制) • [开发](#开发)

</div>

角色卡（V1/V2/V3，PNG/JSON）、提示词预设、世界书、人设、正则、BM25 长期记忆、世界状态变化层、可回滚的楼层操作——全部建立在 dsh 的 agent 运行时之上，不另起发信通道。

体验上近乎 dsh 原生：提示词走宿主的 system-prompt 瀑布（稳定段对齐 DeepSeek 前缀缓存），楼层分支就是真实的 dsh 会话 fork，界面全部挂在宿主原生 slot 上、复用同一套 UI 原语与设计令牌，界面语言默认跟随宿主。会话世系面包屑、工作区、定时计划、中断恢复等宿主能力在 Tavern 会话里照常工作——更像 dsh 自带的一个模式，而不是外挂的前端。

## 功能

- **内置酒馆助手卡面兼容**：本地 jQuery/Lodash/Zod/YAML、真实聊天快照、剧情变量持久化与同剧情跨卡面事件，支持开场白选择、角色卡后台模块脚本、脚本按钮与错误提示。内置全局、预设和角色脚本库的编辑、文件夹管理、导入导出和持久启停；卡内脚本也能更新脚本库并等待保存回执，通过新旧世界书接口读写和切换绑定，支持角色附加书与保留修改的剧情私有书切换，旧世界书设置可按会话覆盖并实际控制扫描。脚本可读取并写回完整消息对象（含完整 swipe 页集合与切页分支），旧消息接口、/swipe 和上下文保存共用持久化与冲突保护，在当前剧情批量保存消息 data/extra，或批量编辑、删除消息，创建保留后续聊天且正确撤销派生事实的独立分支。消息显示支持指定楼层或当前页面插件气泡重绘，保存失败与未提交草稿会阻止刷新。全部卡面就绪后发送消息显示事件，all 重绘完成后发送剧情刷新事件，监听先同步最新剧情变量。当前对话的新消息和生成生命周期也会通知卡片，正常回复等模板与 WAL 收口成功后才触发，历史加载或重连不重复通知。提供 Mvu 手动解析与显式保存、当前沙箱的变量 schema 编辑器。会话可开启原生 MVU 自动初始化和正常回复后更新，等待后台脚本就绪，失败保留任务；下一轮 EJS/宏读取同一剧情变量。需要保持页面打开；classic schema、正文状态栏占位等完整 MVU 兼容仍待适配。聊天与预览共用沙箱；[兼容范围与示例](docs/TAVERN_HELPER.md)说明已实现接口和后续适配范围。

- **角色卡**：导入 / 导出 SillyTavern V1/V2/V3 角色卡（PNG 内嵌或 JSON），支持多开场白 swipe、卡内嵌世界书、正则脚本（`regex_scripts`），交互卡（HTML 封面）在沙箱 iframe 中渲染。
- **提示词预设**：导入 ST 预设 JSON，按 Prompt Manager 语义组装；提示词走 dsh 的 system-prompt 瀑布（稳定段 + 每轮 runtime context），不在前端拼包直发。
- **内置 EJS 模板**：条件、循环、异步表达式、剧情与按消息变量、JSON/YAML 初值、JSON Patch、Zod 校验与世界书装饰器；支持主动激活、跨来源正则、sticky 跨轮注入和闭包、头像上下文、Lodash、Faker 与历史查询。正常完成回复中的脚本只处理一次，重启、分支与楼层回滚保持变量和计数一致。无需另装 ST-Prompt-Template；[兼容范围与示例](docs/PROMPT_TEMPLATES.md)列出接口及宿主差异。
- **世界书**：全局 / 角色 / 会话三级，关键词触发、常驻条目；另有「变化层」支持剧情中的世界状态增改与失效。
- **长期记忆**：BM25 检索 + 时间衰减，模型可通过工具主动读写；超容量时 idle 期自动异步压缩。
- **人设（Persona）**：`{{user}}` 默认值与描述注入。
- **楼层事务**：记忆、世界状态等写入走 WAL（楼层号 + 序号），回退 / 重新生成 / 编辑 = fork 前缀 + 逆序回放 WAL + 子会话续跑；同一楼层 fork 出的分支支持 ‹ n/m › 兄弟导航。
- **AI 代答 / 续写**：代答结果复制到剪贴板；续写不改历史，直接 followup。
- **模型工具（7 个）**：记忆检索 / 写入 / 更新、世界书按条读取、世界状态更新、资产列表 / 读取，供多步 agent 循环按需调用。

真实会话中的交互卡变量通过剧情锁与 WAL 自动保存，保存状态可通过运行时 API 读取；可调用 `await flushHelperVariables()` 等待保存确认。所有作用域按剧情隔离，分支继承后独立变化；角色预览仍为临时数据。备份、恢复与刷新入口位于「Tavern 设置 → 卡片与数据」，按角色和剧情选择已保存快照，不再向角色卡页面插入管理控件。备份上限为 1 MiB，不包含尚未写入变量的表单输入。

管理页编辑有离开确认和浏览器刷新/关闭保护。角色、预设、世界书、用户、正则、记忆和设置的未保存编辑会自动暂存到数据目录的 `editor-drafts/`；看到“草稿已暂存”后，在同一浏览器标签页刷新或重新打开管理页可恢复正文、页签及角色/剧情选择。点击保存才会应用修改，明确放弃会清除对应草稿。浏览器仅保存随机标签页标识，不存编辑正文；禁用浏览器存储或关闭标签页后不保证找回。单份草稿上限 2 MiB，暂存失败会保留页面内容并提供重试。

手机上的 Tavern 设置导航改为顶部横向导航，正文、表单和弹窗底部按钮适配窄屏与短屏。聊天正文使用可用宽度；第三方交互卡内部排版由卡片自身决定。

## 要求

- Node.js ≥ 24
- 已安装 dsh CLI（`0.1.2-rc.1`），并跑过一次 `dsh web`（首次运行会初始化 `web` profile）
- PATH 中有 `pnpm`（`dsh plugin` 命令内部经 pnpm 管理 profile 的插件依赖）

## 安装

插件以**组合包（bundle）**形式安装进 profile。本包在 `package.json` 声明了 `dsh.bundle.patch`，安装后 `dsh` 会自动把它的 patch 层追加进 profile 的 bundles 列表。

```bash
dsh plugin --profile web add github:Amakurai/dsh-liketavern
dsh web   # 重新启动后生效
```

检查安装结果：

```bash
dsh plugin --profile web list --depth 0
```

两点说明（对应官方文档[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)）：

- **git 安装拉的是源码而非构建产物**，pnpm 不会替你跑 `build`。本仓库把构建产物 `lib/` 刻意入库，因此从 GitHub 直接安装即可用。建议锁定 commit（`github:Amakurai/dsh-liketavern#<sha>`），避免后续推送悄悄改变实际运行的内容。
- **安装依赖**：使用 `zod`、`quickjs-emscripten`、`yaml`、`lodash`、`jsonrepair`、`@faker-js/faker`、`ejs`、`showdown` 和 `jquery`，提供不需要原生构建的模板沙箱、初值解析、编译、格式化和卡面兼容。`@deepseek-ai/*` 全部是 peer 依赖，由 profile 里已安装的 dsh 宿主满足。如遇 pnpm 构建脚本拦截，按 dsh 报错核对 profile 中宿主依赖的 `allowBuilds` 配置。
- 也可以走 tarball：作者侧 `npm pack`（`prepack` 会先构建），用户侧 `dsh plugin --profile web add ./dsh-liketavern-0.1.1.tgz`。

版本兼容：本包以 peerDependency 锁 dsh `0.1.2-rc.1`；dsh 处于预发布阶段，升级 dsh 后需同步换装适配的插件版本。版本对应关系见 [CHANGELOG.md](./CHANGELOG.md)。

运行时数据（角色卡、记忆、会话绑定等）落在 `$DSH_HOME/dsh-tavern/`，与本仓库无关。

## 使用

1. 在 dsh web 中新建会话，于英雄区选择「Tavern 模式」并点选角色卡绑定。
2. 在设置面板的 `dsh-tavern` 命名空间下管理角色卡、预设、世界书、人设、正则与采样参数。
3. 对话中可对任意 assistant 楼层重新生成、编辑、回退、续写或让 AI 代答。

插件界面默认英文；如需中文，在 Tavern 设置页「界面 / Interface」子组切换「界面语言 / Language」，立即生效并自动保存（只影响本插件 UI，不影响宿主界面）。

## 剧情状态升级

每个会话及分支现在有独立 storyId。新会话复制角色的初始状态，重新生成在新分支副本内回滚，原会话状态保留。记忆面板先选角色，再选剧情；“初始状态”只用于未来新会话。

旧绑定首次打开会复制旧共享状态，原目录保留、迁移幂等。此前已经混在一起的多分支事实无法可靠自动拆开，请在迁移后核对各剧情。编辑 AI 回复会撤销该层及后续旧事实，不自动推断新事实或续跑。

自动摘要可能遗漏信息；归档原文与来源链保留，BM25 可检索活跃摘要对应的原文。异常、截断或超时的模型流不会归档。分支快照和归档会增加磁盘占用，当前不自动删除旧剧情。

## 平台限制

受 dsh 宿主当前能力所限，以下行为与 SillyTavern 原版不同，属已知边界而非 bug：

- **采样参数**：只有 `temperature`、`maxTokens`、`stop` 与按模型公布的「深度思考」档位会真正送达模型；`top_p` 与惩罚系数在面板中仅作记录，不生效。
- **提示词位置与正则**：静态深度注入进 standing；动态 @D 与作者注释进 runtime context。宿主历史不改写；input/send、prompt/assemble、prompt/send 只用于 ST 模拟和代答，live 展示用 output/render。预览新增“最近宿主请求”（适配器转换前）；其他页签是 ST 模拟。
- **会话日志不可删**：重新生成 / 回退 / 编辑楼层会 fork 出分支会话并在其中续跑，原会话完整保留在会话列表里；同层分支可用操作条上的 ‹ n/m › 导航。
- **AI 代答**：宿主输入区没有插件可写的 API，代答结果只能复制到剪贴板后手动粘贴。
- **多会话与分支**：各自隔离记忆、世界状态、笔记、聊天世界书、定时器和 WAL。角色资产共享；不支持多个宿主进程同时写同一数据目录。

## 开发

```bash
npm install        # 安装开发依赖（公开 npm，精确版本）
npm run build      # tsc 编译 src/ → lib/，再由 esbuild 打 client 单文件 bundle
npm test           # vitest run（例数随改动浮动，不写死在这里）
npm run dev        # dsh web --patch ./cordis.patch.yml（需先把仓库挂进 profile，见下）
```

本地调试：把仓库挂进 profile 的 `node_modules`（需先跑过一次 `dsh web` 使 profile 初始化），然后 `npm run dev`。Windows 用 junction，macOS / Linux 用 symlink：

```powershell
# Windows（PowerShell）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-liketavern" -Target "C:\path\to\dsh-liketavern"
```

```bash
# macOS / Linux（在仓库根目录执行）
mkdir -p ~/.dsh/profiles/node_modules
ln -s "$(pwd)" ~/.dsh/profiles/node_modules/dsh-liketavern
```

注意：

- `lib/` 是交付物，刻意入库；改代码后必须重新 `npm run build`。
- 真实角色卡、运行期 JSON、图片、会话与记忆不要提交进 Git；测试用手写工厂数据。

## 代码结构

```
src/
├── core/     纯函数层（无 I/O，全部可单测）：组装、世界书触发、正则、宏、BM25、分词等
├── state/    存储层（文件 I/O，落 $DSH_HOME/dsh-tavern/）：卡 / 预设 / 世界书 / 记忆 / WAL / 工作区
├── node/     host 运行时：配置、服务、管线、楼层、工具、记忆压缩
├── client/   浏览器 React UI（设置面板、操作条、芯片、英雄区、交互卡渲染）
├── index.ts  host 入口
├── agent.ts  agent 面入口（system-prompt 组装、采样合入、工具注册）
└── remote.ts typert RPC 契约
```

仓库内的开发约定详见 [AGENTS.md](./AGENTS.md)。

## License

MIT
