# 依赖安全记录

本记录说明依赖告警的处理结果与剩余边界，核对日期为 2026-09-19。当前锁文件的 `npm audit` 为 **0 项已知漏洞**；这只表示当前公告数据库没有命中，不能把审计或测试通过解释为不存在未知漏洞。

v0.2.6 发布前本地验收：`npm run build`、全量 **140 文件 / 1986 项测试**、doctor/backup CLI 冒烟与 **425 文件**发布白名单检查通过；Windows 跳过 1 项 POSIX 专属用例。相同依赖和锁文件已在独立空目录完成干净 `npm ci`，仅保留下文说明的上游弃用提示，未审阅安装脚本为 0；最终提交还需通过两平台 CI 的干净安装和完整检查。真实宿主验证新卡导入、EJS 消息格式化、深浅主题和旧已完成历史读取，见 [宿主验收记录](HOST_COMPATIBILITY.md)。

## 已更新的依赖

- `js-yaml` 从 4.3.1 更新到 4.3.2，根级 `overrides` 固定补丁版本，锁文件同步更新。该版本修复恶意空映射合并绕过工作量限制的问题（[GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh)）。本仓库通过开发用 dsh / Cordis 依赖引入它；当前宿主基线为 0.1.5-rc.2。
- `vitest` 从 3.2.7 更新并固定为 4.1.11，相关 `@vitest/*` 包同步更新，修复 redirect mock 越界文件读取（[GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)）。本项目只用 `vitest run` 执行测试，不向外提供 mock 开发服务器；升级仍需运行全量 React、文件系统和 worker 用例。

这些版本约束只作用于本仓库的 npm 安装。发布包不带开发依赖，依赖包的根级 `overrides` 也不会替使用者覆盖其独立安装的 dsh。实际宿主的 `js-yaml` 版本应在宿主安装目录通过 `npm explain js-yaml`（或对应包管理器命令）核对，由宿主依赖升级到兼容的已修复版本；更新本仓库锁文件不等于更新其他安装环境。

## 安装脚本与上游弃用提示

npm 11.16 的安装脚本提醒已逐包审阅，并在项目 `allowScripts` 中仅记录这六个实际版本：`@deepseek-ai/dsh-subprocess-local@0.1.5-rc.2`、`@google/genai@1.52.0`、`esbuild@0.25.12`、`koffi@3.2.1`、`node-pty@1.2.0-beta.15`、`protobufjs@7.6.6`。不使用全局放行或通配符；以后版本变化需要重新审阅。此字段是脚本审批记录，不是脚本权限沙箱，旧 npm 可能不读取它。见 [npm 官方说明](https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/)。

已检查脚本行为：dsh 调整包内 spawn-helper 执行权限；esbuild 准备/验证同版本平台二进制，缺包时从配置的 npm registry 安装并可回退官方 registry；koffi 选择平台预编译包或本地 CMake 构建；node-pty 准备包内 prebuild/ConPTY，缺失时由 node-gyp 构建，可能下载 Node headers；protobufjs 只检查依赖版本写法；Google preinstall 仅输出 no-op。

仍保留一条 **非漏洞的上游弃用提示**：开发宿主的 Google 依赖链通过 `gaxios → node-fetch → fetch-blob` 引入 `node-domexception@1.0.0`。核对时 node-fetch 最新仍为 3.3.2，fetch-blob 最新 4.0.0 仍依赖该弃用包，node-domexception 最新 2.0.2 也已弃用；没有兼容的已发布修复。[上游移除提案](https://github.com/node-fetch/fetch-blob/pull/176)尚未发布。未通过伪造替代包、删除锁文件元数据或关闭告警掩盖该提示，也未跨主版本强改宿主依赖。它不进入插件运行 bundle，宿主依赖升级后应再次核对。

## Showdown：移除受影响解析器

Showdown 的公开最新版本仍为 2.1.0，三份公告均没有可直接升级的修复版本。本次从运行依赖、锁文件和实际 QuickJS 产物移除 Showdown 及其专用 commander 依赖，改用固定公开版本 **markdown-it 15.0.2 / markdown-it-emoji 3.1.0**；没有隐藏告警、重命名漏洞包或保留旧解析器作为回退。markdown-it 15.0.2 包含上游最新的复杂度修复，见 [官方变更记录](https://github.com/markdown-it/markdown-it/blob/master/CHANGELOG.md)。

| 原公告 | 触发条件 | 替换后的行为 |
| --- | --- | --- |
| [GHSA-rmmh-p597-ppvv](https://github.com/advisories/GHSA-rmmh-p597-ppvv) | 恶意嵌套链接使正则长时间计算 | 移除该解析实现。新引擎仍只在 worker 的 QuickJS 内运行，保留内存/执行预算及外层强制终止。输入和输出各限制为 1,048,576 个 UTF-16 码元；大输入超限明确失败，不返回半成品。 |
| [GHSA-cr32-g25g-vxjj](https://github.com/advisories/GHSA-cr32-g25g-vxjj) | metadata 与完整 HTML 文档选项同时开启，标题未经转义 | 新格式化器不解析 metadata、不生成完整文档，也不暴露可修改的解析器对象或全局选项。 |
| [GHSA-22g5-r2x5-97cx](https://github.com/advisories/GHSA-22g5-r2x5-97cx) | 原始表头拼入 HTML 的 `id` 属性 | 新格式化器不生成标题或表头 ID，表格测试继续覆盖注入形状。 |

HTML 格式化结果仍通过 `kind: 'html'` 片段交给现有卡面 iframe，使用 `sandbox="allow-scripts"`，不加 `allow-same-origin`。卡片支持原始 HTML 与脚本，格式化器不是 HTML 清洗器；严禁把结果移入主页面 DOM，业务桥的来源、剧情身份与 WAL 校验仍是必要边界。恶意输入仍可能耗尽当前渲染预算并明确失败。

`test/templateSecurity.test.ts` 用手写攻击形状验证旧库不再装载、无完整文档/标题 ID、HTML 沙箱交付、嵌套链接完整返回或明确资源超限、无限循环被终止、主线程响应及失败后的正常渲染。危险输入只在可终止 worker 中运行。`templateMarkdown` 与 `templateDisplay` 覆盖常用语法和代码/属性边界。

### 格式与旧剧情兼容

通过引擎规则保留表格、换行、删除线、命名 emoji、下划线和图片尺寸；不复制整份旧解析器。新格式遵守 CommonMark 的标题空格规则，`#Heading` 保持普通文本；省略号 `...` 保持原文；仅旧库提供的远程图片 emoji（如 `:octocat:`）不再自动加载；重复引用首次定义优先。复杂 HTML/列表的结构空白及代码块 class 可能变化，不承诺字节完全一致。

已完成回复的保存片段不重算。新重放日志携带 `formatterVersion: 2`；旧版未完成生成或仍持有跨轮回调闭包的日志，在执行任何重放代码前明确拒绝并保留所有数据。因为旧日志没有记录闭包内部的格式化结果，仅比较外显 hash 也不能证明闭包行为不变，不能自动改 hash 或丢弃闭包。升级前先备份、完成旧生成并让相关回调结束；已遇到此诊断时，保留备份，使用原版本完成回调，或回滚到注册相关回调之前的楼层，再升级。普通已完成且无活动重放的旧剧情不受此限制。详情见 [模板说明](PROMPT_TEMPLATES.md)。
