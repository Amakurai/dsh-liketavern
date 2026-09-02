# dsh-liketavern

中文 | [English](./README.en.md)

DeepSeek Harness（dsh）插件，把 `dsh web` 变成 SillyTavern 式的角色扮演前端。

角色卡（V1/V2/V3，PNG/JSON）、提示词预设、世界书、人设、正则、BM25 长期记忆、世界状态变化层、可回滚的楼层操作——全部建立在 dsh 的 agent 运行时之上，不另起发信通道。

## 功能

- **角色卡**：导入 / 导出 SillyTavern V1/V2/V3 角色卡（PNG 内嵌或 JSON），支持多开场白 swipe、卡内嵌世界书、正则脚本（`regex_scripts`），交互卡（HTML 封面）在沙箱 iframe 中渲染。
- **提示词预设**：导入 ST 预设 JSON，按 Prompt Manager 语义组装；提示词走 dsh 的 system-prompt 瀑布（稳定段 + 每轮 runtime context），不在前端拼包直发。
- **世界书**：全局 / 角色 / 会话三级，关键词触发、常驻条目；另有「变化层」支持剧情中的世界状态增改与失效。
- **长期记忆**：BM25 检索 + 时间衰减，模型可通过工具主动读写；超容量时 idle 期自动异步压缩。
- **人设（Persona）**：`{{user}}` 默认值与描述注入。
- **楼层事务**：记忆、世界状态等写入走 WAL（楼层号 + 序号），回退 / 重新生成 / 编辑 = fork 前缀 + 逆序回放 WAL + 子会话续跑；同一楼层 fork 出的分支支持 ‹ n/m › 兄弟导航。
- **AI 代答 / 续写**：代答结果复制到剪贴板；续写不改历史，直接 followup。
- **模型工具（7 个）**：记忆检索 / 写入 / 更新、世界书按条读取、世界状态更新、资产列表 / 读取，供多步 agent 循环按需调用。

## 要求

- Node.js ≥ 24
- 已安装 dsh CLI（`0.1.1-rc.2`），并跑过一次 `dsh web`（首次运行会初始化 `web` profile）
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
- **安装面刻意做小**：运行时依赖只有 `zod`，`@deepseek-ai/*` 全部是 peer 依赖、由 profile 里已安装的 dsh 宿主满足。安装本插件不会拉取宿主本体及其原生依赖（`node-pty` 等），因此正常不会触发 pnpm 的构建脚本拦截（`ERR_PNPM_IGNORED_BUILDS`）。万一遇到，那是 profile 里 dsh 自身依赖的一次性授权：按 dsh 报错提示把包名加进 `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds`，重跑安装命令即可。
- 也可以走 tarball：作者侧 `npm pack`（`prepack` 会先构建），用户侧 `dsh plugin --profile web add ./dsh-liketavern-0.1.1.tgz`。

版本兼容：本包以 peerDependency 锁 dsh `0.1.1-rc.2`；dsh 处于预发布阶段，升级 dsh 后需同步换装适配的插件版本。版本对应关系见 [CHANGELOG.md](./CHANGELOG.md)。

运行时数据（角色卡、记忆、会话绑定等）落在 `$DSH_HOME/dsh-tavern/`，与本仓库无关。

## 使用

1. 在 dsh web 中新建会话，于英雄区选择「Tavern 模式」并点选角色卡绑定。
2. 在设置面板的 `dsh-tavern` 命名空间下管理角色卡、预设、世界书、人设、正则与采样参数。
3. 对话中可对任意 assistant 楼层重新生成、编辑、回退、续写或让 AI 代答。

插件界面默认英文；如需中文，在 Tavern 设置页「界面 / Interface」子组切换「界面语言 / Language」，立即生效并自动保存（只影响本插件 UI，不影响宿主界面）。

## 平台限制

受 dsh 宿主当前能力所限，以下行为与 SillyTavern 原版不同，属已知边界而非 bug：

- **采样参数**：只有 `temperature`、`maxTokens`、`stop` 与按模型公布的「深度思考」档位会真正送达模型；`top_p` 与惩罚系数在面板中仅作记录，不生效。
- **提示词位置**：@D（深度注入）与作者注释在实际请求中并入 system 尾部，不会插入历史消息中间；「预览提示词」里看到的才是完整 ST 序列。
- **会话日志不可删**：重新生成 / 回退 / 编辑楼层会 fork 出分支会话并在其中续跑，原会话完整保留在会话列表里；同层分支可用操作条上的 ‹ n/m › 导航。
- **AI 代答**：宿主输入区没有插件可写的 API，代答结果只能复制到剪贴板后手动粘贴。
- **同一角色卡多会话并发**：工作区与 WAL 以卡为单位共享，多会话并发写入可能交错。

## 开发

```bash
npm install        # 安装开发依赖（公开 npm，精确版本）
npm run build      # tsc 编译 src/ → lib/，再由 esbuild 打 client 单文件 bundle
npm test           # vitest run（例数随改动浮动，不写死在这里）
npm run dev        # dsh web --patch ./cordis.dev.yml（需先把仓库挂进 profile，见下）
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
