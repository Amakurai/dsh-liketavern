# AGENTS.md

给维护者与编码代理的约定。用户说明见 [README](README.md)，状态与提示词设计见 [架构说明](docs/ARCHITECTURE.md)，宿主版本行为见 [兼容记录](docs/HOST_COMPATIBILITY.md)。约定可以在说明理由并验证行为后修改；不要把历史实现当作不可质疑的产品要求。

## 项目与环境

dsh-liketavern 为 DeepSeek Harness 的 Tavern 插件。角色卡、预设、世界书、人设、正则、记忆、世界变化层和分支操作共用 dsh agent 运行时。普通扮演不另起发信通道；AI 代答是明确的辅助调用。

当前基线：dsh / @deepseek-ai 包 0.1.2-rc.1、Node 24、Windows；CI 为 Ubuntu。TypeScript ESM，NodeNext，strict + noUncheckedIndexedAccess，相对导入显式 `.js`。

查宿主机制先看 [官方文档](https://deepseek-harness.github.io/deepseek-harness/) 和已安装包的 `lib/`、`.d.ts`，先核对各包 package.json；不要凭旧版本记忆推断 slot、profile、patch、system-prompt 或事件时序。

## 必须保持的边界

1. **角色资产共享，剧情状态隔离。** `workspace(cardId)` 是角色资产与新会话初始状态；运行中的会话必须经绑定的 `storyId` 使用 `storyWorkspace(cardId, storyId)`。记忆、变化层、笔记、聊天世界书、定时器与 WAL 都属于剧情。不得让 agent、维护或楼层操作退回 cardId 共享可变状态。
2. **分支先准备，后发布。** 锁住来源剧情做文件快照，在草稿内回滚未继承楼层，成功后原子发布，再创建/绑定宿主子会话。不得回滚原会话状态。编辑 assistant 正文撤销该层及后续的派生事实，不自动重新提取事实；用户随后接话或手动修订。
3. **每次楼层写入先 WAL 后正文。** 每轮用 `withFloor(floor)` 派生句柄；共享句柄 floor 恒为 null。面板与维护用 `plainWorkspace(cardId, storyId)`。完整读改写、分支快照与回滚共用工作区锁。损坏日志必须在整批回滚前拒绝；恢复游标必须先于正文替换持久化。不要用“跳过坏行并标记成功”处理故障。
4. **归档来源是数据，摘要是派生视图。** 自动摘要只接受正常 stop 终止帧，错误、截断、无终止帧或超时不能归档原文。失败保留 pending 标记等下一次 idle。检索包含活跃摘要可达的归档来源；去重只查活跃条目。回滚先展开受影响来源链，再撤销事实。
5. **模型请求遵守宿主边界。** standing 是工具说明后的 `tavern:standing`（order 210），turn 是 runtime context `tavern:turn`。绝不使用 complete 段盖掉工具前缀。ST 全量序列是模拟，不能把它称为实际入模消息。input/send、prompt/assemble、prompt/send 的历史改写只用于模拟与代答；live 展示规则是 output/render。
6. **第三方正则与模板不得在 host 主线程执行。** node 调用 `isolated()` 执行 WI、组装与渲染；EJS JavaScript 仅在 worker 内的 QuickJS/WASM 中执行，不暴露 Node、DOM、网络或模块加载器。超时、异常退出、超量输入/输出必须明确失败。core 保持纯函数，静态正则启发式只是提前拒绝，不能代替隔离。模板变量和回复快照属于剧情，预览/重绘不得写入，正常 stop 回复在 turn/end 内只提交一次。
7. **每轮冻结完整提示词计划。** 角色/预设/人设、修订指纹、宏时钟、检索结果与采样在首次成功组装后缓存；后续步骤重放同一份快照。资产编辑下一轮生效，不得把旧内容钉在新修订号下。工具写成功通过 notice 确认，不在同轮重评 WI。`STANDING_PIN_VERSION` 在纪律或段布局变化时递增。
8. **不把第三方代码提升到主页面权限。** 交互卡 iframe 为 `sandbox="allow-scripts"`，不加 allow-same-origin。CSP 默认禁止 connect，允许 http/https/data 图片与字体。ST stub 桥只允许 swipeGreeting，必须校验事件来源窗口；不增加通用主窗口桥。
9. **文件边界与私有数据。** 工具路径经 `resolveReadableAssetPath` 和 `WorkspaceFs`；不读取 WAL、其它 stories、内部 story.json 或二进制。卡片资产与当前剧情合成目录必须排除兄弟剧情。真实数据只在 `$DSH_HOME/dsh-tavern/`，不得进入源码、测试、Git 或 npm 包。

锁是进程内的，同一 DSH_HOME 不支持多宿主进程并发写。旧共享数据首次迁移会保留原目录并复制；已经混合的历史事实无法自动可靠拆分。详见架构说明，不要声称可以无损推断旧分支归属。

## 三面与契约

- host：`src/index.ts` 注册设置、数据目录、预设、service、remote、会话生命周期与请求诊断。
- agent：`src/agent.ts` 组装 standing/turn、合入采样、注册工具和 idle 维护。
- client：`src/client/` 注册五块 slot，只经 typert remote 访问业务状态。
- core：纯函数；state：文件存储；node：宿主编排。

`src/remote.ts` 的 METHODS 必须完整满足 TavernMethodResults 的键集合。TavernMethodRequests 从 schema 推导，TavernRemote 从请求/结果映射生成；service implements TavernServiceContract。新增方法修改 schema、结果表和 service，编译会检查缺项与类型。不再手写客户端请求镜像。

方法返回裸业务值，失败抛错，gateway 生成 `{ ok, value|error }`。复杂资产用 unknown 传输，在服务/存储边界归一化验证，不能因有 TypeScript 注解就信任 JSON。

模型工具共七个：memory_search、memory_write、memory_update、lore_read、worldstate_update、asset_list、asset_read（均带 tavern_ 前缀）。默认直接扮演，只有缺设定、遗忘或已确定事实需要落盘时调用；目录与结果有预算，世界书按 uid/query 分页，禁止整本倾倒。

## 易回归的交互与宿主细节

- cardId 是净化目录名加 hash；展示永远用 card.name。同名卡不覆盖；删除后清绑定，陈旧绑定经 resolveStaleBinding 自愈。
- 导入先 inspectCharacter，不落盘；内嵌世界书由用户选择是否导入，拒绝导入时卡与资产两处都清空。
- 新会话不自动绑默认卡。默认设置只在点选卡时套用；hero 的空白判定和 seatWatch 补偿见兼容记录。
- fork 用 agents.create（session- 前缀）+ workspace.attachSession，带父会话最新 provider/model；开场白预先写进 seed。客户端先 refresh 再 open 子会话。
- 会话级宿主 lineage 面包屑与楼层兄弟导航互补；不要占掉原生 lineage slot。被中断 assistant 的操作由 chat.node 补挂，按 turn 定位。
- runtime context、同轮写入、续写和步骤 notice 均经 isSyntheticUserText 过滤，不当作用户台词，不参与 WI、lastusermessage 或正则 depth。
- 步骤收口 notice 只在工具执行时 inject，不放 agent/pre-step，否则宿主可能多拉出孤儿步骤。
- 采样只透传 temperature/maxTokens/stop 和模型公布的 reasoningEffort；top_p、penalty 仅记录。部署锁定 thinking disabled 时插件不能强开。

## UI 与类型

使用真实 React / 宿主 primitives 类型，不添加 `any` JSX 或模块垫片来让编译通过。开发类型依赖不进入运行 bundle；平台模块保持 external。

remote 经 `$mount(TYPERT_REMOTE)` 安装，调用 `ctx.get('remote.tavern')`，不要在 inject 里声明 remote.tavern。交互组件用宿主 primitives（封装在 util.tsx）；不用原生 select 或 window.confirm。确认用 ConfirmDialog，表单用 SettingsRow/SaveBar，反馈用 Toast，加载用 Skeleton，页签用 Tabs。

样式集中 styles.ts，只用已有 --dsw-* / --tavern-accent-* 变量。动效遵守 prefers-reduced-motion。文案走 useT 与 client/locales 分模块字典，zh/en 同键完整。消息图片用 owner renderMessageImages；MarkdownText 的 labels 与 fileMentions 必须符合宿主真实类型。

## 验证与交付

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

- 改 core/state 必须有对应行为测试。涉及宿主事件、分支、请求或故障时，补真实文件系统 + 模拟宿主/适配器的集成测试；不得以“host/UI 不测”为由跳过关键路径。
- 重点回归：storyIsolation、transactionRecovery、robustBoundaries、pipelineCache、floorConcurrency、i18n。测试用手写工厂数据，不调用真实模型。
- tests 直接 import src；Node 24 下 worker 源码测试使用类型剥离，交付运行只用 lib JS。正则超时测试必须在隔离 worker 中进行。
- 每个源文件和测试用中文块注释说明职责；标识符英文。测试验证业务结果与失败边界，避免只镜像实现。
- 运行依赖为 zod、quickjs-emscripten、yaml、lodash、jsonrepair、@faker-js/faker、ejs、showdown；模板库用于实际兼容编译参数、消息格式化、schema、Lodash、模型 JSON 修复与 Faker 全语言数据，构建为带许可证的 QuickJS 内部脚本，不桥接 Node 函数。Showdown 仅在可终止 worker 的 QuickJS 中使用，关闭 metadata 与标题 ID；HTML 产物只能交给原有沙箱 iframe，不能放入主页面。隔离 JavaScript、有界初值解析与新增兼容库固定公开 npm 版本，不用 node:vm 冒充安全边界。宿主包走精确 peer，开发依赖公开 npm 精确版本。禁止 file:、绝对路径或链接依赖；开发挂载仓库的 junction/symlink 是另一件事。
- lib/ 刻意入库。所有 src 改动必须重建；CI 会拦过期、缺失和未跟踪产物。不要忽略 lib/。
- npm 包白名单：lib、cordis.patch.yml、presets、README 两种语言、CHANGELOG、LICENSE。禁止 src/test/node_modules/本机数据。
- 宿主升级按 [版本核对清单](docs/HOST_COMPATIBILITY.md) 执行；构建/测试不能代替安装环境的 boot 与 UI 冒烟。
