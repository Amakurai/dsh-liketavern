<div align="center">

# dsh-liketavern

**在 DeepSeek Harness 的 `dsh web` 中使用角色卡、世界书与长期记忆，开始 Tavern 式角色扮演。**

**[v0.2.1](https://github.com/Amakurai/dsh-liketavern/releases/tag/v0.2.1) · 适配 dsh `0.1.2-rc.1` · Node.js ≥ 24**

中文 | [English](./README.en.md)

[安装](#安装) · [开始使用](#开始使用) · [功能](#功能) · [兼容范围](#兼容范围) · [数据与备份](#数据与备份) · [常见问题](#常见问题) · [开发](#开发)

</div>

导入 SillyTavern 角色卡和提示词预设，在同一个 dsh 会话里管理设定、推进剧情、重新生成和切换分支。普通对话使用 dsh 的模型配置与 agent 运行时，界面沿用宿主的操作方式，并默认跟随宿主语言。

内置 EJS 提示词模板、酒馆助手部分接口和可选原生 MVU。第三方卡片能否直接使用，取决于其依赖的接口；具体范围见下方[兼容说明](#兼容范围)。

## 安装

### 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | 24 或更新版本；当前开发与 CI 使用 Node 24 |
| dsh CLI / 宿主 | **`0.1.2-rc.1`**，本插件的宿主依赖锁定此版本 |
| pnpm | 已安装且可在终端运行，供 `dsh plugin` 管理插件依赖 |
| 模型 | 在 dsh 中完成模型配置，能够正常对话 |

首次使用 dsh 可先参考[官方文档](https://deepseek-harness.github.io/deepseek-harness/)，运行一次 `dsh web` 完成配置。`web` profile 会在首次启动或安装插件时自动初始化。

### 安装正式版本

在终端执行，固定到发布标签：

```bash
dsh plugin --profile web add github:Amakurai/dsh-liketavern#v0.2.1
dsh plugin --profile web list --depth 0
```

确认列表中出现 `dsh-liketavern` 后，停止已运行的 dsh，再启动：

```bash
dsh web
```

本仓库包含编译好的 `lib/`，普通安装无需自行构建。插件会作为组合包自动加入 `web` profile；安装机制见官方[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)。

### 使用安装包

从 [v0.2.1 Release](https://github.com/Amakurai/dsh-liketavern/releases/tag/v0.2.1) 下载 `dsh-liketavern-0.2.1.tgz`，在文件所在目录执行：

```bash
dsh plugin --profile web add ./dsh-liketavern-0.2.1.tgz
```

安装后同样重启 `dsh web`。Release 附有 `SHA256SUMS.txt`，可用于核对下载文件。

### 升级

先核对[更新日志](./CHANGELOG.md)中的宿主版本，停止 dsh 并备份数据，再执行目标版本的安装命令。升级插件沿用现有数据目录；完整备份范围见[数据与备份](#数据与备份)。

未带 `#版本标签` 的 GitHub 地址跟随仓库默认分支。希望固定运行内容时，使用正式标签或具体 commit。升级 dsh 宿主前，也需要确认有对应的插件版本。

## 开始使用

1. **准备角色卡。** 在 dsh 设置中的「Tavern → 角色」页导入 PNG / JSON，或创建角色。导入时可以选择是否接收卡内嵌世界书。
2. **新建剧情。** 新建会话，选择「Tavern 模式」，再点选角色卡。新会话不会自动绑定默认角色；空列表中的「导入 / 创建角色」也可打开管理页。
3. **选择开场白。** 有多条开场白时用左右按钮切换，再点「开始对话」；没有开场白的卡可直接输入。
4. **调整设定。** 点击会话顶部的角色入口，为当前会话选择提示词预设、人设和世界书。公共资产在 Tavern 设置中管理，人设位于「用户」页。
5. **继续或修改剧情。** 使用 AI 回复旁的操作条进行重新生成、编辑、回退、续写或 AI 代答；同一楼层的分支可用 `‹ n/m ›` 切换。

**脚本和 MVU：** 全局、预设和角色脚本统一在「Tavern → 设置 → 脚本」管理，可编辑、启停和查看运行错误。需要自动 MVU 的卡，还需在会话顶部的角色配置中勾选「启用原生 MVU 自动更新」并保存；运行时保持该会话页面打开。

**界面语言：** 默认跟随宿主（中文宿主显示中文，其余显示英文）。可在「Tavern → 设置 → 界面 → 界面语言」固定为中文或 English，选择后立即保存，仅影响插件界面。

## 功能

| 功能 | 当前能力 |
| --- | --- |
| 角色卡 | 导入 V1 / V2 / V3 的 PNG、JSON 角色卡，导出 PNG / JSON；多开场白、内嵌世界书、卡内正则与 HTML 交互卡 |
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

## 兼容范围

### 第三方卡片、模板和脚本

- **酒馆助手提供部分兼容接口。** 支持变量、脚本库、世界书与多种消息操作；`generate` / `generateRaw`、消息插入与旋转、历史分页和跨页面事件等仍待适配。完整接口和示例见[酒馆助手兼容说明](docs/TAVERN_HELPER.md)。
- **EJS 模板已内置。** 使用已支持接口的卡无需另装 ST-Prompt-Template；提示词位置、历史处理等宿主差异见[提示词模板说明](docs/PROMPT_TEMPLATES.md)。
- **MVU 支持有边界。** 纯官方 MVU 导入入口可适配到原生执行器，自定义框架保持原代码；classic schema 与 `BEFORE_MESSAGE_UPDATE` 正文更新钩子仍待适配。当前界面没有独立的变量 schema 编辑器入口。
- **交互卡在隔离 iframe 中运行。** 不提供主页面 DOM、`parent.TavernHelper`、`parent.$` 或 Node 访问。网络请求及外部脚本默认受限，可在「设置 → 卡片与数据」配置可信域名；图片和字体按现有策略加载。
- **脚本选项不会自动发送。** 后台脚本发布的文字选项由用户点击后填入当前输入草稿；AI 代答目前仍使用剪贴板，需要手动粘贴。

### 提示词、采样和楼层操作

| 项目 | 实际行为 |
| --- | --- |
| 采样参数 | `temperature`、`maxTokens`、`stop` 及模型公布的思考档位可以生效；`top_p`、惩罚系数仅记录。宿主锁定关闭思考时，插件不能强制开启 |
| 提示词预览 | 「最近宿主请求」显示实际捕获的请求（适配器转换前）；其他页签是重新计算的 ST 模拟，不能代表实际入模消息 |
| 正则与位置 | 实时展示使用 `output/render`；`input/send`、`prompt/assemble`、`prompt/send` 的历史改写只用于模拟与代答。静态深度内容进入稳定提示词段，动态 `@D` 和作者注释进入每轮上下文 |
| 改写与删除 | 楼层编辑、回退、重新生成及脚本消息删除通过分支实现，原会话保留。编辑 AI 正文会撤销该层及后续派生事实，不自动重新提取或发起回复 |
| 回滚范围 | 回滚覆盖插件剧情状态；剧情工作区之外的工具副作用不会随楼层操作撤销 |

## 数据与备份

插件数据位于 `$DSH_HOME/dsh-tavern/`。未设置 `DSH_HOME` 时，默认是 `~/.dsh/dsh-tavern/`（Windows 为 `%USERPROFILE%\.dsh\dsh-tavern\`）。宿主聊天记录与配置还保存在 dsh 的其他目录；完整迁移或升级备份应在停止 dsh 后复制整个 `DSH_HOME`。

**角色资产共享，剧情状态隔离。** 同一角色的卡片、预设和脚本资产可复用；每个剧情及分支独立保存记忆、世界变化、笔记、聊天世界书、变量和回滚日志。新剧情复制角色初始状态，修改「初始状态」只影响之后创建的剧情。同一数据目录不支持多个宿主进程同时写入。

| 保存方式 | 包含什么 | 如何恢复 / 注意事项 |
| --- | --- | --- |
| 交互卡变量备份 | 已保存的当前剧情变量，变量数据最多 1 MiB | 「设置 → 卡片与数据」选择角色与剧情，导出或粘贴备份恢复；不包含消息正文、角色卡、脚本资产或尚未写入变量的表单输入 |
| 编辑草稿暂存 | 角色、预设、世界书、用户、正则、记忆和设置的未保存编辑 | 出现「草稿已暂存」后，在同一浏览器标签页刷新或重开编辑器可恢复；仍需点保存才能应用。单份上限 2 MiB |
| 完整目录备份 | 插件数据以及宿主会话、配置等 | 停止 dsh 后备份整个 `DSH_HOME`；上述变量导出不能替代完整备份 |

编辑草稿保存在插件数据目录的 `editor-drafts/`，浏览器只保存随机标签页标识。关闭标签页或禁用浏览器存储后不保证恢复；暂存失败会保留页面内容并提供重试，明确放弃会清除对应草稿。角色预览中的交互数据是临时的，不会写入真实剧情。

旧版共享状态会在首次打开旧绑定时复制到独立剧情，原目录保留。此前混合的多分支事实无法自动可靠拆分，需要核对迁移结果。自动摘要可能遗漏信息，原文来源会保留；异常、截断或超时回复不会触发归档。分支与归档会占用磁盘，当前不自动清理旧剧情。

## 常见问题

**安装后没有 Tavern 模式或设置入口？** 先用 `dsh --version` 确认宿主为 `0.1.2-rc.1`，再用 `dsh plugin --profile web list --depth 0` 检查安装目标。重启 `dsh web` 后新建会话；仍未出现时，查看终端中的插件加载错误。

**卡片能显示，但按钮、脚本或 MVU 不工作？** 在「设置 → 脚本」检查脚本及所在文件夹是否启用并保存，查看当前会话的运行诊断。MVU 还需开启会话内的自动更新选项并保持页面打开。对依赖父窗口对象或未实现接口的卡，按[兼容说明](docs/TAVERN_HELPER.md)检查依赖。

**pnpm 提示构建脚本被拦截？** 本插件随包提供编译产物；先核对报错涉及的具体依赖。插件源码构建问题可尝试改用 Release 安装包；宿主依赖的构建要求仍需按 dsh 提示，检查对应 profile 的 `pnpm-workspace.yaml` 中的 `allowBuilds` 配置。

反馈问题时，请提供插件与 dsh 版本、操作步骤、相关错误及去除私人内容的最小复现。可在 [GitHub Issues](https://github.com/Amakurai/dsh-liketavern/issues) 提交。

## 文档

| 文档 | 内容 |
| --- | --- |
| [更新日志](./CHANGELOG.md) | 版本变化与宿主对应关系 |
| [酒馆助手兼容说明](docs/TAVERN_HELPER.md) | 卡面、脚本、变量、世界书、消息和 MVU 接口 |
| [提示词模板说明](docs/PROMPT_TEMPLATES.md) | EJS、宏、装饰器与示例 |
| [架构说明](docs/ARCHITECTURE.md) | 剧情隔离、分支回滚、记忆和提示词通道 |
| [宿主兼容记录](docs/HOST_COMPATIBILITY.md) | 已核对的宿主行为及升级检查 |
| [开发约定](./AGENTS.md) | 代码边界、测试与交付要求 |

## 开发

在 Node 24 下，从仓库根目录执行：

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

`lib/` 是提交到 Git 的交付物，修改 `src/` 后必须重新构建并同步提交。`npm pack` 会先构建；发布包仅包含编译产物、插件配置、预设及发布说明文件。测试使用手写工厂数据，不提交真实卡片、会话或记忆。

<details>
<summary>本地挂载与调试</summary>

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

## License

[MIT](./LICENSE)
