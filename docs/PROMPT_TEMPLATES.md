# 内置提示词模板

dsh-liketavern 内置 EJS 模板执行与剧情变量，不需要另装 ST-Prompt-Template。它提供该插件的核心用途，兼容范围如下；不是 SillyTavern 扩展加载器，也不是其全部 API 的复刻。

## 支持的内容

| 内容 | 行为 |
| --- | --- |
| `<% JavaScript %>`、`<%= expression %>`、`<%- expression %>` | 执行、按阶段格式化输出、原样输出；支持条件、循环、函数、Promise、await；生成阶段 `<%=` 原样输出 |
| `<%# comment %>`、`<%%`、`%%>`、`-%>`、`_%>`、`<%_` | 注释、字面标签和空白控制 |
| 角色定义、预设、已触发世界书、深度提示、人设、AN、笔记 | 首次组装时执行；含模板的内容进入 tavern:turn，同轮后续步骤复用 |
| `getvar / setvar / incvar / decvar / delvar` | JSON 变量树、点路径、方括号数组路径；get/set/inc/dec/del 的 Local/Global/MessageVar 别名 |
| `insvar / insertLocalVar / insertGlobalVar / insertMessageVar` | 数组插入、字符串插入、对象属性设置；delvar 支持相应删除，非法索引不修改变量 |
| `jsonPatch / patchVariables` | add/remove/replace/move/copy/test、JSON Pointer 转义、数组插入；在副本上完成整批检查，失败不保留部分修改 |
| `scope` | global/local/message 持久化；cache 仅本次执行；initial 只读 |
| 常用变量选项 | defaults、clone、index、merge、nx/xx/n/nxs/xxs、old/new/fullcache；inc/dec 支持 inscope/outscope/min/max |
| `withMsg / findVariables` | 按文本索引、角色与当前 swipe 查询或修改当前剧情的消息快照；findVariables 在给定消息之前寻找最近的变量树 |
| `[InitialVariables]` | 启用的世界书条目提供 JSON 或 YAML 初始对象；在每次执行中作为默认值合并，已保存的值优先 |
| `getwi / getWorldInfo` | 从当前绑定的世界书按 uid/标题读取并展开，可传局部 data；省略库名优先当前条目的来源库，其次角色主世界书；显式库名使用 sourceRef |
| `getchar / getChara / getchr` | 读取当前角色完整定义，包括系统提示、性格、描述、对话示例及深度提示；自定义模板可使用 name/scenario/first_message/message_example 等角色字段 |
| `getCharData / getCharaData` | 按当前角色名、cardId 或正则取根字段与 data 的独立快照；保留扩展数据，不包含 PNG 字节和内部存储记录 |
| `getpreset / getPresetPrompt / getprp` | 当前预设启用条目，按 identifier/name 读取展开，支持局部 data 和身份宏 |
| `getWorldInfoData / getEnabledWorldInfoEntries` | 当前绑定库的条目；提供 key/keysecondary 数组、disable、world 等 ST 字段；后者包含禁用条目并支持来源开关 |
| `activewi / activateWorldInfo` | 按绑定库的 uid/标题主动激活；嵌套请求去重，在同轮重组进真实 turn 上下文；force 可启用禁用条目并跳过概率，仍遵守条件、预算、定时器和 dont_activate |
| `selectActivatedEntries / getWorldInfoActivatedData / activateWorldInfoByKeywords` | 主键/次键、选择逻辑、大小写/整词和正则匹配；支持 constant/disabled/vectorized 条件筛选；后者将结果登记为本轮主动激活 |
| `evalTemplate / define / print / parseJSON` | 嵌套模板、同次执行内定义与输出；define 支持属性路径、返回旧值、数组拼接和对象合并，嵌套函数绑定当前模板上下文；parseJSON 用 jsonrepair 修复模型 JSON，不执行输入代码 |
| `evalTemplate(text, data, options)` | 使用真实 EJS 6.0.1；支持分隔符、空白处理、strict/_with、localsName、destructuredLocals、outputFunctionName、escape、context 与 async；include 只接受自定义 includer 返回的模板文本 |
| `z / setVariableSchema` | 真实 Zod 4.4.3，支持字段 schema 对象或 Zod schema；对象根允许额外字段；类型、默认值、coerce、transform、同步 refinement 统一校验变量写入/删除/补丁 |
| `getChatMessage(index, role?)` | 当前冻结的文本历史，先过滤角色再索引，支持负下标 |
| `getChatMessages(count, role?) / (start, end, role?)` | 正 count 取前 N 条，负 count 取最后 N 条；区间先过滤角色、end 不包含；零起点区间有效，不包含合成 notice/runtime context |
| `matchChatMessages(pattern, options)` | 冻结历史上的字符串/正则查询；支持区间、角色及 and（同一消息匹配全部条件） |
| `injectPrompt / getPromptsInjected / hasPromptsInjected` | 按名称收集提示词、按 order 排序、按非空 uid 替换；无 uid 时按组和正文去重；默认延迟展开；sticky 随剧情持久化，预览不消耗次数 |
| `{{outletPromptsInjected:key}}` | 最终组装和回复处理时展开命名注入；支持嵌套出口，拒绝循环和超量输出，展开后重新校验窗口预算 |
| `_` | 内置 Lodash 4.18.1 的完整库，包含集合、链式、路径、模板等 API；捕获冻结时钟/随机源；宿主定时器、网络或 Node 能力仍不提供 |
| `faker` | @faker-js/faker 10.6.0 完整 namespace，含 77 种 locale、官方实例和构造器；首次访问时在 QuickJS 内加载，内置实例默认使用本轮 seed/now |
| `[GENERATE:BEFORE] / [GENERATE:AFTER]` | 使用普通 WI 触发规则，在模拟序列首条正文前/末条正文后执行并原样拼接；对应动态正文映射到真实本轮上下文 |
| `@INJECT pos=… / target=… / regex=…` | 按位置、角色出现次数或第一条正则匹配插入独立消息；支持 role、order、at；DeepSeek 官方布局通道保留位置，其它通道映射到 tavern:turn |
| `[GENERATE:index:BEFORE/AFTER] / [GENERATE:REGEX:pattern]` | 在模拟消息正文前后追加内容，正则忽略大小写并匹配每条；提供 matched_message、matched_message_index、matched_message_role 和 world_info |
| `[RENDER:BEFORE] / [RENDER:AFTER]` | 启用条目按 order 排序，围绕正常完成的 assistant 正文执行 |
| assistant 回复中的 EJS | 完整 turn 正常完成且该 step 有 stop 终止帧时执行；变量与展示结果一次原子写入 |
| `@@activate / @@dont_activate` | 常驻激活/禁用；dont_activate 优先 |
| `@@generate_before / @@generate_after / @@render_before / @@render_after / @@initial_variables` | 与相应标题标签等价；generate 可带整数下标或 `REGEX:模式`，负下标从末尾计算；@@always_enabled 可以启用被禁用的特殊条目 |
| `@@if expression` | WI 扫描前只读求值，false 不参与分组、递归和预算；条件条目进入 turn；渲染条件在对应条目执行前判断，可以读取正文刚更新的变量 |
| `@@preload / @@only_preload / @@dont_preload` | 按 order 建立函数与临时默认变量；重放不重设 sticky，资产变化才重新注册；only_preload 不作普通注入，dont_preload 优先，输出不直接持久化 |
| `@@private` | 局部声明块；渲染条目也分别求值，避免声明互相污染 |
| `@@preprocessing / [Preprocessing]` | 在 WI 扫描前展开正文、主键和次键；输出参与递归扫描，条件不成立的条目不执行，组装不重复运行副作用 |
| `activateRegex` | 临时字符串/同步回调替换，支持 uuid 更新、order、角色（含 system）、worldinfo 和深度过滤；未指定 message/generate 时默认 basic，指定后不再默认开启；message 可在回复 EJS 前（before）或后（after）处理正文 |

变量 `char`、`user`、`variables`、`initialVariables`、`defines` 可直接访问。`assistantName/charName/userName`、`model`、最后用户/角色消息正文及索引来自冻结快照；当前宿主没有群聊，`groupId=null`、`groups=[]`。正常回复逐条提供 `name/message_id/swipe_id/is_last/is_user/is_system`，宿主事件序号单独放在 `hostMessageId`，不会与文本索引混用。时钟和 Math.random 在同一执行里冻结/确定；下一轮重新取快照。`saveVariables()` 是兼容调用，实际持久化统一由楼层提交控制。

`charAvatar` 和 `userAvatar` 提供当前角色及人设的 PNG data URL，同轮冻结。只读取固定头像文件并剥离 PNG 内嵌卡片元数据；缺失、块结构无效、图像块超过 384 KiB 时返回空字符串，不读取头像字段中的任意路径或外部地址。

`evalTemplate` 默认允许 await；`async:false` 使用同步模板和同步 include。路径参数只用于虚拟模板标识与 includer，不能读取磁盘。自定义 escape、includer 及模板函数仍只在 QuickJS 内运行。

装饰器必须连续写在正文最前面的独立行，`@@@` 保留为普通文字。未知名称按上游规则丢弃；已经识别但未支持的装饰器明确报错。`@@if` 不允许修改变量，也暂不能修饰 InitialVariables；需要更新状态时请放在正常模板正文。字符串匹配使用字面子串，需要正则时显式传 RegExp。

预加载适合 `define('hpText', function() { return this.getvar('hp'); })` 这样的共享函数，以及 `setvar('hp', 10, 'nx')` 临时默认值。它不会在打开卡片、预览或下一次重建沙箱时重复写剧情。后续正式模板中的 `incvar('hp', 2)` 才提交 12。预加载期 `dryRun: true` 的强制持久化明确拒绝；推荐用 InitialVariables 配置初值。

JSON Patch 支持根路径替换，但拒绝删除整个 JSON 文档、原型路径、非法转义和数组越界；每批最多 1024 项。变量补丁仍受 JSON 大小限制和楼层事务约束。

schema 与定义的函数会随本轮生成快照一起恢复到回复沙箱。也可以在 `@@only_preload` 条目中注册共享规则，例如：

```ejs
@@only_preload
<% setVariableSchema(z.object({
  hp: z.coerce.number().min(0).max(100),
  inventory: z.array(z.string()).default([]),
})); %>
```

校验和转换在副本上完成，成功后才写入目标作用域；转换生成的默认值也写入该作用域，不复制其它作用域的无关字段。失败的 setvar/delvar/patchVariables 保留旧状态，可由模板捕获错误。校验函数不能反向修改变量，异步校验和非 JSON 输出明确拒绝。生成正文注册的 schema、define 和回复正则回调保留本轮词法闭包，无需为了跨阶段使用而改写成预加载。

Zod 和 Lodash 的用户回调也在 QuickJS 内执行，受相同时间/内存约束；`_.template` 不能取到 Node。依赖浏览器专属全局的库方法（例如 URL 对象校验）不保证可用，定时器方法也不提供宿主定时器。jsonrepair 只修复可解释为数据的输入，不能用它执行 JavaScript。

Faker 使用官方 namespace，例如 `faker.fakerEN.person.fullName()`、`faker.fakerZH_CN.location.city()`；也可用 `new faker.Faker({locale:[faker.zh_CN,faker.en,faker.base]})` 创建自定义实例。已有实例默认种子和参考日期随本轮冻结，显式 seed/setDefaultRefDate 仍按官方行为工作。全部语言数据随包发布，在沙箱内按需解析，无联网加载。自定义 randomizer 等回调仍受相同时间和内存限制。

主动激活与组装在同一 worker 中完成。预设、角色或世界书模板提出新的 activewi 请求后重新选择与落位，已经求值的来源只重放结果；定时器每次从相同轮初快照计算，最终只提交一次。回复阶段的 activewi 暂不支持，不会假装登记后丢弃。原始 WI 定时和预算规则仍有效，force 不提供无界倾倒或覆盖 dont_activate 的权限；返回条目表示找到并登记，最终是否注入可看触发日志。

临时正则的 message 规则支持字符串与同步函数回调，正文没有 EJS 时也会产生展示快照。回调可以捕获共享局部变量；生成、回复和后续轮次按有界执行记录重建同一词法环境，逐步核验结果及最终变量，不重复提交旧增量。after 处理 EJS 输出后的正文，指定 after 时 before 默认关闭；两者也可同时显式开启。异步返回、异常和超限使整次处理失败。隐藏推理与最终 DOM HTML 模式不提供。

三类 sticky 的清理时点不同：命名提示词在成功生成组装、出口展开后减一，小于零删除；generate 正则同一时点减一，小于等于零删除；message 正则在下一次生成开始时减一，小于等于零删除。生成正文注册的 prompt sticky=1 覆盖当前及下一轮；generate/message 正则需 sticky=2。preload 早于轮首清理，因此预加载的 message 正则也需设置保留次数。basic 只参与本次组装，不跨轮保留。同 UUID 的 generate/message 分别更新，重注册才重设计数。预览、同轮多步、消息重绘和提交重试都不多扣次数。

定位语法写在世界书条目标题中。例如 `@INJECT target=user,index=-1,at=before,role=system` 将正文插在模拟序列最后一条 user 消息之前。`pos` 从 1 开始，0 也指第一条之前，负数从末尾计数，超出尾部则追加；target 的 index 同样从 1 开始并支持负数。GENERATE 的消息下标从 0 开始并支持负数。`@INJECT regex="pattern",at=after` 区分大小写，先执行位置/角色注入，再定位第一条匹配消息；`[GENERATE:REGEX:pattern]` 不区分大小写，向所有匹配消息前追加正文，`@@generate_after REGEX:模式` 则追加在匹配消息后。未找到目标时不执行该条目脚本。

同位置注入按 order 升序排列，默认使用世界书条目的 order。启用的 @INJECT 条目按常驻条目参与选择，禁用条目不会自动启用；可显式使用 `@@always_enabled`。条件、dont_activate、WI 预算与总窗口限制仍有效。GENERATE 定位遵循普通 WI 触发条件。所有定位正则都在可终止 worker 中匹配，异常或超时拒绝整次组装。调用 activewi 导致重组时，定位模板重放首次求值结果和局部消息快照，避免重复写变量；相同正文的多条消息仍分别执行。

生成模板的 `generateData` 是包含预设、角色与历史的完整 ST 模拟序列，保留 EJS 处理前的正文。全局 BEFORE 执行后先对整包正文应用 basic 规则，再关闭 basic 阶段；之后的消息和钩子看到 basic 处理后的 generateData。activewi 重组沿用首次 basic 规则快照，后注册的 basic 规则不混入本轮 generate 阶段。

GENERATE 钩子的 `generateBuffer` 是该钩子之前已收集的正文。执行按全局 BEFORE→逐消息 BEFORE/正文/AFTER→全局 AFTER 推进，钩子原样拼接，需要换行时由模板提供。普通模拟消息先按整条合并正文执行 generate 正则，再执行 EJS，支持跨来源匹配和捕获替换；GENERATE 钩子与定位阶段的 `@INJECT` 按条目先执行 generate 正则，再求值模板。`{{outlet::名称}}` 带入的原文与父模板共同编译，服从父模板的条件和循环，并共享词法变量。上游将生成缓冲字段定义为 GENERATE 钩子的上下文；普通嵌套片段不逐段更新该缓冲。这些字段都不是 dsh 的实际请求消息。

activewi 重组复用相同来源的模板结果及相同匹配身份的回调结果；新匹配或显式重新注册的规则仍会执行回调，新一轮清除匹配缓存。所有输出按实际正文检查预算。

DeepSeek 官方通道会把已求值的定位内容保存为结构化布局，按原 role 和消息 ID 插入请求副本；GENERATE、INSERT 与延迟出口不会在后续工具步骤重新执行。原历史正文、图片、工具调用和结果保持不变，插入不能拆开工具交换。深度落在已压缩的历史中时只能定位到摘要边界。其它供应商通道仍把定位正文映射为 `tavern:turn` 段落，尚不保留精确角色与位置；供应商专用助手预填也尚未接入。

system 位置还取决于模型能力：支持中途更新的模型在各个位置接收完整系统快照；只支持首条 system 的模型合并系统条目并在「最近请求」记录差异，user/assistant 的定位保留。模板不能借增量 system 片段丢弃宿主工具说明。

示例：把下面内容放在常驻世界书里：

```ejs
<% setvar('affinity', 0, 'nx'); %>
好感度：<%- getvar('affinity') %>
<% if (getvar('affinity') >= 50) { %>
角色已经信任对方，会主动分享自己的经历。
<% } else { %>
角色仍然谨慎，需要通过互动逐渐建立信任。
<% } %>
```

需要让回复调整变量时，可在角色写作规则中规定输出相应脚本，例如 `<% incvar('affinity', 5) %>`。脚本由本地沙箱执行；不会要求模型代替 JavaScript 求值。角色规则应限制何时允许调整数值。

## 执行、持久化与回滚

RENDER 条目支持 `@@iframe` 与 `@@message_formatting`。`@@iframe 状态` 把该条目放入默认折叠、标题为「状态」的卡面；省略标题时直接显示。两项同时使用时，先格式化 Markdown，再放入 iframe。它们只适用于 `[RENDER:BEFORE]` / `[RENDER:AFTER]`（或对应位置装饰器）。

生成阶段 `<%=` 原样输出，回复阶段将值格式化为消息 HTML；`<%-` 保持原样。粗体、表格、代码块、删除线、命名 emoji、下划线与图片尺寸使用固定版 markdown-it 15.0.2 / markdown-it-emoji 3.1.0 及少量兼容规则，在 QuickJS 内执行。这里不复制 ST 的主题、Markdown 自定义扩展和用户格式化设置。标题遵守 CommonMark 空格规则（`#Heading` 是普通文本），`...` 不自动替换为省略号，旧库的远程图片 emoji 如 `:octocat:` 保留原文；复杂列表/HTML 的结构空白和代码块 class 可能与旧 Showdown 不同。

双/三下划线表示下划线，单下划线保留原文；反引号代码、原始 `<code>` 与 HTML 属性不参与格式替换。支持行内及引用式图片尺寸（如 `![图](image.png =100x200)`），只接受有界数字、常用单位与 `*`，不接受任意属性/CSS。重复引用定义遵循 CommonMark 的首次定义优先规则，旧 Showdown 的后定义覆盖行为不再复制。

回复快照保存 BEFORE→正文→AFTER 的有序 Markdown/HTML 片段及折叠标题。普通格式化 HTML 也通过现有 `sandbox="allow-scripts"` iframe 显示，不获得主页面或同源权限；标题作为 React 文字显示。片段内的 output/render 正则在隔离 worker 中执行，不跨卡面/正文边界匹配；需要跨边界替换的旧规则须改为针对单段内容。关闭交互卡时保留正文，只有 HTML 的回复回退到已求值文本，不再次执行或露出原始 EJS。旧快照继续使用原展示方式。

`state/template.json` 位于绑定的 storyWorkspace，是三个持久作用域、按宿主消息 seq 保存的展示快照，以及未结束轮次生成恢复记录的原子提交入口。小状态保留原 JSON；超过 64 KiB 后保存版本 2 根引用，正文按内容摘要存放在同剧情的 `state/template-data/`。对象和数组分页，对象的分页边界由键决定，在任意位置新增消息快照只重写所在页；未变的回复、消息变量与分页共用不可变数据块，新增楼层不再把整份历史反复写进 WAL。恢复记录仍包含完整冻结计划与可校验的操作重放；即使模板只定义函数而未写变量，也会保存。大型状态下这份记录的正文每轮整体替换，单独写入 `state/template-generation/<楼层>.<摘要>.json`，根里只留归属与摘要：正文先于根落盘、不记 WAL，读取时核对体积与摘要，收口或同一楼层重新生成后，仅清理当前根与本层最终回滚根均不需要的正文。楼层外手动维护可能保留 prepared 根，因此不能只看当前根删除正文；清理判断失败时保守保留。清理仅缓存少量已验证根摘要到正文路径的映射，根、块或缓存代次变化时作废，未知根仍完整读取验证。回滚算法只操作根和块，恢复后读取 prepared 仍需其正文。新块一次记入 `withFloor` 的 WAL 后落盘，最后原子替换根；失败保留旧根，分支复制根、块、正文与 WAL，回滚先恢复根再撤销本层新块。读改写和组装共用工作区锁。同轮两个并发组装不会把自增执行两次；重组时每个父来源复用首次结果，其嵌套 outlet 属于该次完整执行，循环内或被不同父来源包含时按各自控制流求值。脚本显式调用 getwi/evalTemplate 也按调用次数求值。

旧完整 JSON 在校验后可读，下一次写入按需迁移；本地调高总文件限制留下的旧状态也接受同样的结构、单块与展开预算检查。缺失、篡改、循环引用或超预算的数据块明确拒绝；写入与读取使用同一展开预算，能保存的状态一定能读回。核对结论与递归冻结的解析结果在进程内复用，楼层归属、定时器和单条回复只复制所需字段；逻辑 JSON 深度与物理分页深度分别验证，合法深数组冷读不会因分页而失败。同一轮的多次读取只读根文件；工作区内的改写、删除与回滚会使其作废，进程外对数据块的改动在下次启动时核对。数据块可能被旧 WAL 引用，不能单独清理；`state/template-generation/` 里的正文可能仍被根引用，同样不能手工删除。备份和恢复应覆盖整个剧情。迁移后的大型状态不兼容旧版读取器，回退插件版本前应恢复升级前的完整备份。

生成阶段模板写入在成功组装和预算验证后提交。回复阶段使用本轮冻结的资产快照与生成阶段提交后的变量，不重新读取中途修改的角色/世界书。完整回复中的全部模板成功后，才一起写入变量和展示快照。错误、截断、无 stop 终止帧、被中断的 turn 都不提交回复阶段的变更；生成阶段已提交的变更仍属于该楼层，可通过回滚撤销。

生成恢复记录、变量、消息快照、sticky 注册表及 WI 定时器通过同一次根原子替换提交。prepared 阶段只保存一份闭包日志；回复完成或终止后，仍有活跃回调时把日志转入 continuation，最后一个回调到期后释放它，保留完成回执和过期记录。到期清理不会先追加日志而被旧操作上限挡住；覆盖、停用的回调释放强引用，仍被脚本持有的函数再次注册时保留身份。重放包含阶段切换、消息上下文与回复操作，既恢复共享局部变量，也核验消息快照摘要；普通变量和上下文不是词法闭包的完整检查点，不能据此截断存活回调的日志。日志只记录进入沙箱的操作：某阶段没有临时正则时，逐条消息的变换不留记录；各来源求值共用的模拟序列与累积缓冲存入日志的共享表，记录处只留引用，重放时展开成与记录时逐字节相同的入参。没有临时正则时，单轮操作数与历史长度无关。basic 正则直接在 QuickJS 中按最多 512 条消息分批处理并记批次日志，批次大小不限制整段历史；generate 保持与各消息 EJS 交错，直接调用来源变换，不再为每条消息编译 EJS 包装。阶段上下文按字段共享，历史与消息身份数组以严格 JSON 前缀追加，旧阶段按各自长度读取；历史被编辑或不再是前缀时转为内容寻址的数组页；消息变量等对象按有序键和子节点共享，未变的正文与快照不再整表复制。结构引用先检查拓扑、逻辑深度、重复键和单操作展开总量，再恢复原始 JSON；分页不会改变入参键序或执行结果。跨轮回调因此无需在每个阶段重存完整旧历史，重放计算预算仍按逻辑工作量计入共享引用，不能因日志压缩而缩短正常恢复期限。旧版逐条内联日志保持原始哈希语义，超过原 4 MiB 但仍在资源容量内的合法日志可以恢复。

长期存活的闭包使用持久 QuickJS 检查点。跨轮环境在导出时，尾部累计达到 256 条操作或约 1 MiB 日志即保存完整可恢复的 WASM 状态，再释放检查点之前的操作与共享入参。检查点保留词法变量、共享引用、循环对象、schema 函数和回调身份；旧内联日志首次正常恢复后也按此规则转入检查点。未进入跨轮续存的普通单轮生成仍用紧凑日志，避免为短暂环境保存整堆。检查点后的操作按原顺序校验重放；重启或缓存淘汰后，从最近检查点继续，不再从最早注册回调的那一轮开始执行。

堆映像按固定 64 KiB 内存页分别压缩，未变页复用内容寻址数据块；v2 用 null 表示全零页，旧 v1 仍可读取。保存前完整校验固定分配器布局，然后只清除快照副本里已经释放的内存内容。最高地址的连续空闲区可按页裁掉，至少保留 4 KiB top，并同步更新副本的分配器元数据；大型临时对象释放后，历史峰值留下的尾部内存因此不必一直跟着存档。保存不会额外触发 GC，不提前运行 Promise，也不改变 WeakRef 的原有行为。

裁剪立即减少存档和下次冷恢复的内存；当前热 VM 的内存要等环境替换或 worker 回收后才释放。这不等于所有内存都能缩回去：夹在活对象之间的空闲碎片只能清零，不能移动活对象来合并；脚本一直保留的历史、数组和闭包仍需完整保存。检查点大小和恢复工作量取决于这些状态、无法裁掉的布局及尾部操作，不能保证无限恒定大小。达到资源容量时明确失败，不丢弃活动对象。收口后的 continuation 检查点遵守普通状态块与 WAL 规则，不属于可删除的未结束轮次生成正文；分支和回滚同时保留它。

连续会话还可复用最近的隔离执行环境：最多两个 worker，以完整重放摘要和会话身份匹配，命中后仅移交一次沙箱所有权；并发重试或回滚后的状态恢复独立副本。普通气泡展示不会清掉模板闭包缓存。持有活闭包的空闲 worker 最多保留五分钟，其余一分钟；资源被回收或宿主重启后，从检查点及其尾部日志校验恢复，没有检查点的旧状态仍走完整重放。每次任务重新获得自己的时间与 QuickJS 预算，异常或超时淘汰整个 worker。

恢复末态的变量与消息快照查询也可能运行 schema 回调；冷热恢复执行相同校验，并把这些实际发生的查询记入后续日志，不再丢失校验期间的闭包副作用。schema 排入的堆内 Promise 微任务也由检查点保存，恢复不提前执行它们，仍在原有渲染队列处理位置继续。校验尾部的容量检查延后到下一次正常操作或导出，允许最后一个到期回调先释放旧日志。

回复计算成功而保存失败时保留待恢复记录和未提交 WAL。新宿主轮次先用原正常结束帧与冻结计划补交，再开启新楼；缺少原结束帧或重试仍失败则明确阻止新轮，允许恢复原结束事件或回退，不能把待提交回复静默标为终止。模板脚本本身出错仍沿原终止策略处理。恢复前校验剧情归属、宿主轮次、记录内容和原 WAL。`state/wal-coverage.json` 独立保存已知楼层，缺失日志会阻止回退和分支发布；重开同名楼层必须证明清单中旧身份已完成回滚，空目录或更早的同名日志不能冒充恢复证据；不要通过删除 WAL 释放容量。旧 `state/wi-timers` 文件保留为迁移与回滚来源；分支复制不改祖先模板文件。旧版本未完成的重放记录明确拒绝混用新语义，需要完成或回滚相应楼层。

冷启动查询生成归属、定时器或元数据时，仅展开相应字段；展示按宿主消息身份和实际续写来源选择回复块。旧分页格式仍需扫描键页，但不读取无关回复正文。局部读取只证明所选数据有效，不替代完整状态校验；写入和回滚继续验证完整可达图。路径解析结果单独缓存，工作区写入或回滚会使其失效。

展示接口只读取保存的回复结果，不在页面刷新时重复执行 setvar。开场白或独立文本预览在临时变量副本里执行，不保存更改。编辑 assistant 撤销该层模板状态，不自动执行编辑后的新脚本。模板出错会在触发日志中显示来源与错误；没有成功快照的含脚本回复显示错误，不能假装处理成功。

**更换格式化器的升级边界：** 新日志标记 `formatterVersion: 2`。缺少该标记的旧未完成生成日志或跨轮闭包日志仍可读取、备份和显示已有结果，但不能在新引擎中继续重放；执行前明确拒绝并保留变量、日志和 WAL。闭包内部可能捕获格式化字符串，而旧日志只记录外显结果的 hash，不能据此证明状态等价，也不能直接改 hash 或静默丢闭包。升级前应备份并完成旧生成、让相关回调结束；已升级后遇到诊断时，可保留备份后使用原版本完成，或回滚到注册相关回调之前，再升级。已完成且没有活动重放的普通旧剧情可以继续使用，旧回复的保存片段不会重算。

**检查点的版本边界：** v1 引擎的 JS 胶水、包装器、FFI 和 WASM 作为整包随插件保留；普通构建只校验并复制，不随 npm 依赖升级重新生成。模板 helper/vendor 的实现指纹另行登记，并通过稳定的宿主通信 ABI 判断兼容性。已登记的旧运行时可直接恢复原堆，继续使用原有 helper/vendor 和格式化行为，后续检查点仍保存原指纹。旧环境结束后，新建环境才使用当前实现；更新插件不会强行替换存活闭包内部捕获的函数或值。

未知、已撤销或 ABI 不匹配的运行时，会在开层、恢复冻结计划或结束提交前明确拒绝，保留原根和 WAL；存档自报相同 ABI 不能让未知指纹通过。此机制支持已登记的兼容版本，不提供任意未来不兼容引擎的自动迁移。遇到不兼容时可使用创建检查点的版本继续，或从兼容的较早楼层分支；不能只改版本号、重新运行预加载或丢掉闭包来冒充恢复。

global 是**当前剧情内的独立命名空间**。message 快照按宿主稳定 Message.id 保存，文本索引与事件 seq 分开。新消息只继承一次最近前序状态；已初始化的后代不会因祖先变量被修改而重新继承。普通 stop 回复也保存继承快照。旧单树只用作当前新目标的迁移基线，不伪造整段历史。

`getMessageVar('hp')` 默认读取合并缓存，`getMessageVar('hp',{withMsg:{id:-1}})` 读取指定消息的原始快照。withMsg 只作用于 message scope，显式 id 优先于 role，负下标从文本历史末尾计算。`findVariables('hp',n)` 不包含第 n 条，跳过 hp 为 null/undefined 的快照，返回整树引用；未找到时返回 InitialVariables。只暴露当前剧情的 swipe 0（-1 也表示它），不读取兄弟剧情。角色精确匹配，不复制上游角色误匹配和不存在 swipe 写入的缺陷。

历史变量写入仍记在**当前执行楼层**的 WAL，不改旧聊天正文，也不污染当前缓存；回滚当前层会撤销这次历史修改。消息快照参与条件只读检测、schema 和重放摘要核验。分支复制快照后独立推进；iframe 内的 Tavern Helper 临时变量仍属于卡面，和 EJS 剧情变量不是同一个存储面。

## 边界与不兼容项

- 不提供 STscript、Slash/Quick Reply、SillyTavern DOM/事件总线、外部网络、文件系统、require/import 模块或通用宿主调用。
- 受识别的未支持定位与变量选项会明确报错；其余缺失函数由 JavaScript 报错。`@INJECT` 与 GENERATE 定位的真实宿主映射见上文。
- getwi 只能读取已经绑定的世界书，不读取其它角色、兄弟剧情或任意磁盘文件。工具资产接口也拒绝读取内部模板快照。
- 历史入模消息由 dsh 管理；这里不改写宿主历史、工具前缀或 complete 段。ST 模拟序列与真实宿主请求仍分别展示。
- 普通 WI 在只读条件筛选后选择触发条目；预处理条目提前展开并参与递归，其余在组装时执行。预加载重建定义和缓存，不模拟 ST 开卡时持久化与所有扫描时序。依赖这些机制的卡需要改写触发方式。
- 变量要求无循环 JSON，禁止原型路径和非有限数值。普通作用域变量与单条消息快照各保留 1 MiB 限额；消息集合不再按 4096 条或总计 1 MiB 拒绝，只有可见快照送入隔离器。已有历史不消耗 GENERATE 的 1 MiB 净扩张额度，模拟序列求值后仍核对冻结模型窗口，真实请求窗口由宿主管理。
- worker 和 QuickJS 按冻结输入规模分配内存与累计时间，小输入维持原预算；大输入的 worker 计算至多 30 秒、QuickJS 至多 15 秒，受信依赖累计装载至多 10 秒，512 KiB 栈不变。worker 传输资源上界为输入 128 MiB 字符、输出至多 256 MiB；内存分别至多 1536 MiB / 512 MiB。仍会终止死循环和灾难正则，显式超时不被大输入覆盖。
- 磁盘单块最多 4 MiB，完整状态与生成恢复正文按 UTF-8 字节最多 64 MiB；重放和消息快照集合受 64 MiB 字符资源保护。重放不再按 4096 次操作或 4 MiB 拒绝。跨轮闭包定期用完整 VM 检查点替换旧操作，避免日志单纯因执行轮数不断增长；活动堆、历史上下文与检查点尾部仍受资源容量保护，不能保证无限增长的脚本状态永远可容纳。

新增依赖 `quickjs-emscripten` 和 `yaml` 是为了独立 JavaScript 运行时与标准的有界 YAML 解析，均为公开 npm 固定版本，不需要原生构建。没有把第三方脚本放入 Node 主线程或主页面。

`zod`、`lodash`、`jsonrepair`、`ejs`、`markdown-it` 与 `markdown-it-emoji` 在构建时生成带原始及传递依赖许可证的 `lib/vendor/template-libraries.js`，由 worker 在 QuickJS 中加载。发布产物包含这份文件；安装后不需要 esbuild，不从磁盘加载第三方卡片指定的模块。

2026-09-19 已移除存在三份漏洞公告且没有已发布补丁的 Showdown；当前锁文件 `npm audit` 为 0 项已知漏洞。新引擎不生成 metadata 完整文档或标题/表头 ID；计算仍有 worker/QuickJS 时间和内存限制，格式化 HTML 只进入无同源权限的 iframe。具体修复与验证见 [依赖安全记录](DEPENDENCY_SECURITY.md)。

Faker 单独生成 `lib/vendor/template-faker.js`，保留原始许可证；普通模板只接收脚本文本，首次访问 faker 才在 QuickJS 内编译和执行。语言 fallback 链在构建时逐一与官方实例核对，行为测试也直接比较官方库的输出。

接口对照来源：[ST-Prompt-Template](https://github.com/zonde306/ST-Prompt-Template)、[API 定义](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/reference.md)、[功能说明](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/features.md)。实现为独立代码，没有引入该仓库的执行源码。

维护者的接口核对与验证证据见 [兼容核对](ST_COMPATIBILITY_AUDIT.md)。
