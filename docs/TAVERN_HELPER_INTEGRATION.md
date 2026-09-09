# 酒馆助手完整适配进度

目标是把酒馆助手能力融入 dsh 并验证可用。以下是交付检查表，未勾选项不代表已兼容。基线为上游 b3cc5162bfad3fcdee858bf83a73209aff21d656 的公开类型；独立实现适配，不复制上游扩展实现。

## 已验证基础

- [x] 卡面本地依赖、变量同步 API、错误展示、局部事件、开场白选择。
- [x] 真实聊天 append 原文快照、连续下标、合成消息过滤。
- [x] 剧情变量落盘、稳定消息身份、逐表并发校验、WAL、分支复制和回滚。
- [x] 固定宿主上下文的窄业务桥、来源校验、迟到回执隔离、保存失败可见。

- [x] 实际 dsh 0.1.2-rc.1/Windows 临时安装验收：真实 UI 导入、无模型开场白、卡面与后台脚本变量同步、重绘、页面重开及 WAL 文件验证。

## 待完成与验收

- [x] 卡面快照主动刷新，同页面变量保存通知与未修改卡面自动同步，刷新时的未保存修改保护。
- [x] 同页面实际插件气泡显示完成事件：全部卡面就绪后一次 CHARACTER_MESSAGE_RENDERED，all 完成后一次 CHAT_CHANGED，回调前刷新剧情快照及一次性监听失败保护。
- [x] 当前 Tavern 页面的宿主增量消息与生成通知、正常收口屏障、加载/重连去重和旧来源取消；等待首消息的后台脚本自动启动。
- [ ] 历史分页、会话选择的 CHAT_CHANGED 与跨页面同步。
- [x] 新旧角色卡脚本树读取、会话级后台模块沙箱、脚本按钮、临时暂停/启动及剧情脚本变量初始化。
- [x] 角色脚本资产编辑、文件夹移动/排序、JSON 导入导出、持久启停、草稿恢复与修订冲突保护。
- [x] 全局/当前预设脚本库的持久存储、编辑、导入导出及共同加载，跨库 ID 冲突和绑定切换保护。
- [x] 真实会话卡面/后台脚本的脚本树写入 API、动态按钮和说明持久化、回执确认后重载、冲突草稿及绑定锁保护。
- [x] 同页面同剧情的跨脚本/卡面 JSON 事件，整组监听排序、一次性监听、参数修改回传、错误传播和可重入调用。
- [x] MVU 本地同步读取、手动解析、跨卡面可变事件钩子及显式保存回执；有界普通 JSON 命令和 JSONPatch。
- [x] 当前 iframe 的变量 schema 编辑器：异步校验/转换、固定消息目标、冲突草稿与重绘保护；程序写入不受 UI 结构约束。
- [x] 原生 MVU 自动初始化与正常 stop 更新：脚本就绪、剧情持久任务/完成回执、同轮 WAL、队列保留及通信失败重试。
- [x] EJS/宏只读 MVU 消息变量视图、同轮冻结和下轮刷新，不复制可变状态。
- [ ] MVU classic schema、状态栏占位与正文更新、完整兼容卡验收及跨页面事件。
- [ ] 非 JSON 事件参数（函数/原型对象）的沙箱兼容方案，以及依赖跨窗口同步回调的脚本适配。
- [x] 现代世界书目录/当前绑定读取、公共库/角色内嵌书/剧情聊天书 CRUD、条目 updater 与创建删除、版本冲突和聊天 WAL。
- [x] 旧 lorebook 目录/当前绑定读取与条目 API：字段往返、UID 局部更新、批量返回值、同 UID 额外字段保留；条目级组计分进入真实引擎。
- [x] 世界书绑定修改与旧绑定别名：当前会话全局/角色主附加选择，剧情私有书切换/解绑/复用，单文件 WAL、分支隔离及同轮计划冻结。
- [x] 旧世界书设置：当前会话部分覆盖、同步快照/串行持久化、失败草稿、最少激活扩深、面板恢复默认及实际管线验证。
- [ ] 向量触发及角色/人设/预设/正则/原始资产 CRUD 与导入导出适配。
- [x] setChatMessages 批量正文编辑：独立分支保留后续正文、撤销派生事实、移除过时压缩、回执确认后跳转及失败重试入口。
- [x] setChatMessages 消息 data/extra 批量原子保存、逐表原值冲突保护、变量队列同步，以及正文混编草稿中的新身份和子会话 WAL。
- [x] 完整消息对象往返、只读属性校验、mes 及当前 swipe 页正文/data/extra 写入、不同表示冲突拒绝与独立副本。
- [x] 完整 swipe 页集合：新增/删除/修改页、每页变量与元数据、选中页切换分支、重启/继承/WAL、冲突和失败边界。
- [x] 旧 setChatMessage、/swipe 和上下文 swipe/saveChat 接入现代消息事务，页数据别名、变化行保存与上下文草稿冲突保护。
- [x] deleteChatMessages 批量删除：独立分支保留后续历史、成组移除工具轨迹/流式/压缩、清理消息状态、宿主关系不变量及清空后续聊验证。
- [x] refreshOneMessage、仅 id 刷新、none/affected/all 的已挂载插件气泡重绘：准备/确认后替换、相同 HTML 重启、草稿/恢复表单保护、超时和真实浏览器验证。
- [ ] 其它消息属性、隐藏、插入、旋转，以及宿主原生用户气泡刷新、消息修改/增删专用事件适配。
- [ ] generate/generateRaw、流式事件、取消、提示词注入与工具注册，遵守 dsh 请求边界。
- [ ] Slash 解析与项目业务命令映射；不直接运行宿主 shell。
- [ ] 音频播放器、播放列表、音量与用户交互后播放。
- [ ] 上下文/宏/格式化/显示消息/脚本工具补齐。
- [ ] 扩展管理等 SillyTavern 专有接口逐项提供 dsh 等价能力或明确可见的差异。
- [ ] 全套手写兼容卡、真实安装环境 boot 与 UI 冒烟、包产物和文档审计。

## 上游函数核对目录

此目录是待审计接口清单，不能当作支持清单；已支持范围以 [接口说明](TAVERN_HELPER.md) 为准。iframe 独立声明的事件/脚本辅助接口同样纳入上述验收。

| 模块 | 公共函数 |
| --- | --- |
| audio | `playAudio`、`pauseAudio`、`getAudioList`、`replaceAudioList`、`appendAudioList`、`getAudioSettings`、`setAudioSettings`、`getCurrentAudio` |
| builtin | 类型/常量声明 |
| character | `getCharacterNames`、`getCharacterIds`、`getCurrentCharacterName`、`getCurrentCharacterId`、`createCharacter`、`createOrReplaceCharacter`、`deleteCharacter`、`getCharacter`、`replaceCharacter`、`updateCharacterWith` |
| chat_message | `getChatMessages`、`setChatMessages`、`createChatMessages`、`deleteChatMessages`、`rotateChatMessages` |
| displayed_message | `retrieveDisplayedMessage`、`formatAsDisplayedMessage`、`refreshOneMessage` |
| extension | `isAdmin`、`getTavernHelperExtensionId`、`getExtensionType`、`getExtensionInstallationInfo`、`isInstalledExtension`、`installExtension`、`uninstallExtension`、`reinstallExtension`、`updateExtension` |
| generate | `getProxyPresetNames`、`generate`、`generateRaw`、`getModelList`、`stopGenerationById`、`stopAllGeneration` |
| global | `initializeGlobal`、`waitGlobalInitialized` |
| import_raw | `importRawCharacter`、`importRawChat`、`importRawPreset`、`importRawWorldbook`、`importRawTavernRegex` |
| index | 类型/常量声明 |
| inject | `injectPrompts`、`uninjectPrompts` |
| lorebook | `getLorebookSettings`、`setLorebookSettings`、`getLorebooks`、`deleteLorebook`、`createLorebook`、`getCharLorebooks`、`getCurrentCharPrimaryLorebook`、`setCurrentCharLorebooks`、`getChatLorebook`、`setChatLorebook`、`getOrCreateChatLorebook` |
| lorebook_entry | `getLorebookEntries`、`replaceLorebookEntries`、`updateLorebookEntriesWith`、`setLorebookEntries`、`createLorebookEntries`、`deleteLorebookEntries` |
| macro_like | `registerMacroLike`、`unregisterMacroLike` |
| persona | `getPersonaNames`、`getPersonaIds`、`getCurrentPersonaName`、`getCurrentPersonaId`、`getPersonaAvatarPath`、`getPersona`、`createPersona`、`createOrReplacePersona`、`deletePersona`、`replacePersona`、`updatePersonaWith` |
| preset | `isPresetNormalPrompt`、`isPresetSystemPrompt`、`isPresetPlaceholderPrompt`、`getPresetNames`、`getLoadedPresetName`、`loadPreset`、`getPreset`、`createPreset`、`createOrReplacePreset`、`deletePreset`、`renamePreset`、`replacePreset`、`updatePresetWith`、`setPreset` |
| raw_character | `getCharData`、`getCharAvatarPath`、`getChatHistoryBrief`、`getChatHistoryDetail` |
| script | `getAllEnabledScriptButtons`、`getScriptTrees`、`replaceScriptTrees`、`updateScriptTreesWith` |
| slash | `triggerSlash` |
| tavern_regex | `formatAsTavernRegexedString`、`isCharacterTavernRegexesEnabled`、`getTavernRegexes`、`replaceTavernRegexes`、`updateTavernRegexesWith` |
| util | `substitudeMacros`、`getLastMessageId`、`errorCatched`、`getMessageId` |
| variables | `getVariables`、`replaceVariables`、`updateVariablesWith`、`insertOrAssignVariables`、`insertVariables`、`deleteVariable`、`registerVariableSchema` |
| version | `getTavernHelperVersion`、`getTavernVersion` |
| worldbook | `getWorldbookNames`、`getGlobalWorldbookNames`、`rebindGlobalWorldbooks`、`getCharWorldbookNames`、`rebindCharWorldbooks`、`getChatWorldbookName`、`rebindChatWorldbook`、`getOrCreateChatWorldbook`、`getWorldbook`、`createWorldbook`、`createOrReplaceWorldbook`、`deleteWorldbook`、`replaceWorldbook`、`updateWorldbookWith`、`createWorldbookEntries`、`deleteWorldbookEntries` |
