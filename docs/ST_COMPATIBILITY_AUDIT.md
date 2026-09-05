# ST-Prompt-Template 兼容核对

2026-09-05 按上游 [reference](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/reference.md)、[features](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/features.md) 及固定 commit `9bf9bcdfa8d0d38ab1f4f7342067bc16f347d85d` 的实现核对。项目内置执行能力，使用下述兼容接口的卡无需另外安装该插件。完整接口和宿主映射见 [模板说明](PROMPT_TEMPLATES.md)。

## 本轮补齐的兼容

| 项目 | 实现与验证证据 |
| --- | --- |
| 默认上下文 | charAvatar/userAvatar 从当前固定头像文件生成有界 PNG URL，剥离卡片元数据；templateAvatar 验证路径、空值、尺寸、轮初冻结与持久恢复 |
| generate 正则跨来源匹配 | 对普通合并消息执行全文变换并保留来源区间，支持跨边界捕获替换、生成/删除 EJS；templateGeneration 验证 activewi 同来源复用与 basic 分界，templateRegexSources 对照原生捕获替换，并验证同匹配缓存、重注册及跨轮清理 |
| sticky 注入与正则 | 独立 prompt/generate/message 生命周期、注册覆盖与过期表；templateSticky、templateContinuation 验证共享闭包跨生成/回复/后续轮次及 preload 不复活，templateContinuationState 验证真实文件提交、重启、预览、截断、失败重试、分支与回滚 |
| 按消息变量 | withMsg/findVariables 与稳定 Message.id 快照、一次继承、当前层 WAL；templateMessageVariables 验证索引、角色、引用与 schema、普通 stop、同 seq 编辑、坏 hash、重启与分支隔离 |

## 已修正的差异

- EJS 使用真实 6.0.1，覆盖第三参、嵌套上下文、同步/异步 include 与多参数 print；include 不提供文件系统。
- 生成阶段闭包通过确定性操作重放恢复，冻结计划与变量、计时器共同持久化；重启后恢复后续步骤和正常回复，完成回执防止重复执行。已有真实文件系统、写入故障、坏 WAL、停止/截断、分支与回滚测试。
- `<%=` 生成原样、回复消息格式化；`@@iframe` / `@@message_formatting` 的 BEFORE→正文→AFTER 有序片段与折叠标题随回复原子保存。Showdown 的代码块、表格、HTML、emoji 已与官方输出对照；所有 HTML 进入不透明来源 iframe，展示正则不跨片段边界，ST 主题及自定义 Markdown 扩展不在本次映射中。
- 回复逐条建立姓名、文本索引、swipe、最后标记及正则深度，宿主 seq 单独传递；默认名字、最后消息、模型与群聊空值已覆盖。
- generateData 提供未经 EJS 处理的完整 ST 模拟序列；全局 BEFORE 之后先应用 basic，逐消息与后续钩子读取 basic 处理后的序列。GENERATE 钩子的 generateBuffer 按前后顺序推进，普通嵌套资产不额外承诺逐片段推进。装饰器支持下标及 REGEX 参数，实际展开正文参与预算检查，同一父来源 activewi 重组复用首次结果。
- `@INJECT` 与普通生成正文均先执行 generate 正则，再求值 EJS。宏 outlet 原文与父模板共同编译，保留父条件、循环与词法变量；templatePlacement 和 templateGeneration 验证动态创建/删除 EJS、跳过 false 分支、循环副作用及重组后新来源加入。对应固定版本的 [生成处理](https://github.com/zonde306/ST-Prompt-Template/blob/9bf9bcdfa8d0d38ab1f4f7342067bc16f347d85d/src/modules/handler.ts#L243-L253) 与 [定位注入](https://github.com/zonde306/ST-Prompt-Template/blob/9bf9bcdfa8d0d38ab1f4f7342067bc16f347d85d/src/features/inject-prompt.ts#L71-L84)。
- 命名注入支持延迟出口及嵌套展开，循环与超量输出明确失败，最终展开后重新校验预算；动态出口进入 turn。
- Faker 使用完整真实库与全部语言；默认 seed/now 冻结，惰性装入，测试与官方输出逐项比较。
- getchar 返回完整定义，getCharData 包含 ST 数据结构，补读取别名；getwi 默认库与嵌套来源准确，不按数组顺序误选全局书。
- injectPrompt 无 uid 按组和正文去重；define 支持属性路径、合并、返回旧值及嵌套函数当前上下文绑定。
- activateRegex 修正 basic 默认选择，支持 system、after 文本处理；保留真实宿主历史边界。
- 模板变量与 WI 定时器原子提交，失败重试使用冻结计划；已验证文件故障、分支和祖先回滚。

## 宿主边界

完整 ST DOM、事件总线、其他扩展 API、跨剧情共享可变状态、任意重写真实宿主历史不能直接映射。沙箱展示、历史查询和消息快照通过项目自身接口实现；上表列出的功能有对应行为测试，真实消息角色和排列仍遵守 dsh 宿主约束。全文 generate 正则的匹配范围是普通模拟消息；GENERATE 钩子与 `@INJECT` 分别按条目处理，不跨多个钩子或注入条目匹配。

## 维护约束

- sticky 必须区分三类注册表：prompt 在成功生成组装、出口展开后递减并于 `<0` 删除；generate 正则同一时点递减并于 `<=0` 删除；message 正则在下一次非预览生成开始递减。basic 在全局 BEFORE 后处理整包正文，随后清空活动表并关闭该阶段；首次规则快照只供同轮重组使用，生成结束再清理后注册的 basic。同 UUID 的 generate/message 是独立记录，重新注册才重置计数。不能让每次沙箱 preload 重建都算一次新业务注册，否则过期规则会复活。
- 跨轮闭包需要延续有界的阶段操作记录，包含回复操作、消息上下文与阶段切换；两个回调共享的词法变量必须一起恢复。旧增量只在重建副本中执行。持久化 carry 与变量、计时器和冻结计划一次提交；到期无闭包后可压缩记录。仅保存函数文本或上一轮 generation trace 不足以恢复回复之后的闭包状态。
- 消息变量以宿主 `Message.id` 定位，冻结文本索引到 message id/seq 的映射；不能用正文哈希猜测同文本输入，也不能把 seq 当文本下标。当前剧情只暴露一个 swipe，分支继承身份但隔离快照。旧状态只能建立明确迁移基线，不能把当前变量伪造为每条历史消息的状态。
- `findVariables(key, mes_id)` 查 mes_id 之前的当前版本快照，指定 key 时跳过 null/undefined，返回整树；withMsg 只对 message scope 生效。已初始化后代不随祖先修改重新继承；旧目标的写入记在当前楼层 WAL。普通 stop 回复也需继承快照，预览和重绘仍只读；快照摘要纳入 replay 验证与条件纯度检查。
- 上游变量选择存在角色误匹配、历史写入污染当前缓存及不存在 swipe 的边界缺陷，应明确修正而非复制。参考固定版本 [变量实现](https://github.com/zonde306/ST-Prompt-Template/blob/9bf9bcdfa8d0d38ab1f4f7342067bc16f347d85d/src/function/variables.ts)、[注入实现](https://github.com/zonde306/ST-Prompt-Template/blob/9bf9bcdfa8d0d38ab1f4f7342067bc16f347d85d/src/function/inject.ts)、[正则生命周期](https://github.com/zonde306/ST-Prompt-Template/blob/9bf9bcdfa8d0d38ab1f4f7342067bc16f347d85d/src/function/regex.ts)。
