# 内置酒馆助手运行层

本项目按 dsh 的剧情、WAL 和沙箱机制独立适配 Tavern Helper 公共接口，不打包上游扩展实现。核对基线为 [JS-Slash-Runner b3cc5162bfad3fcdee858bf83a73209aff21d656](https://github.com/N0VI028/JS-Slash-Runner/tree/b3cc5162bfad3fcdee858bf83a73209aff21d656/%40types)。完整适配仍在进行，未实现的接口不以空结果冒充成功；[完整适配进度](TAVERN_HELPER_INTEGRATION.md)记录剩余模块。

## 已支持的卡面接口

| 类别 | 接口或行为 |
| --- | --- |
| 本地依赖 | jQuery 3.7.1、Lodash、Zod、YAML、jsonrepair；保留许可证，只在 iframe 中执行 |
| 变量 | getVariables、replaceVariables、insertOrAssignVariables、insertVariables、updateVariablesWith、deleteVariable、getAllVariables |
| 作用域 | chat、character、global、preset、message、script、extension；真实会话按剧情持久化，预览为临时数据 |
| 事件 | eventOn、eventOnce、eventMakeFirst、eventMakeLast、eventEmit、eventEmitAndWait、eventRemoveListener、eventClearEvent、eventClearListener、eventClearAll |
| 上下文 | getCurrentMessageId、getLastMessageId、getIframeName、getMessageId、同步 getChatMessages（也可 await）、SillyTavern.getContext |
| 旧消息入口 | 真实会话 setChatMessage、/swipe 与上下文 swipe/saveChat 共用现代消息事务；预览仍只支持开场白操作，/pass 保留宏展开 |
| 消息编辑 | setChatMessages 批量正文修改（编辑分支）、data/extra 原子保存（当前剧情或混编分支）；deleteChatMessages 批量删除（删除分支） |
| 消息显示 | refreshOneMessage、setChatMessages 的 none/affected/all；重建同页面已挂载的插件消息气泡，完成后发送 CHARACTER_MESSAGE_RENDERED，all 完成后发送 CHAT_CHANGED |
| 辅助 | substitudeMacros 的 char/user/currentMessageId/lastMessageId、errorCatched、卡内 toastr 文字提示 |
| 脚本库 | getScriptTrees、replaceScriptTrees、updateScriptTreesWith、getAllEnabledScriptButtons（真实会话卡面和后台脚本） |
| 脚本库同步扩展 | flushHelperScripts、refreshHelperScripts、getHelperScriptStatus |
| 世界书 | getWorldbookNames、getGlobalWorldbookNames、rebindGlobalWorldbooks、getCharWorldbookNames、rebindCharWorldbooks、getChatWorldbookName、rebindChatWorldbook、getOrCreateChatWorldbook、getWorldbook、createWorldbook、createOrReplaceWorldbook、deleteWorldbook、replaceWorldbook、updateWorldbookWith、createWorldbookEntries、deleteWorldbookEntries |
| 旧世界书 | getLorebooks、createLorebook、deleteLorebook、getCharLorebooks、getCurrentCharPrimaryLorebook、setCurrentCharLorebooks、getChatLorebook、setChatLorebook、getOrCreateChatLorebook、getLorebookEntries、replaceLorebookEntries、updateLorebookEntriesWith、setLorebookEntries、createLorebookEntries、deleteLorebookEntries |
| 世界书目录刷新 | refreshHelperWorldbooks（真实会话） |
| 世界书设置 | getLorebookSettings、setLorebookSettings、flushHelperWorldbookSettings、getHelperWorldbookSettingsStatus |
| 剧情同步扩展 | flushHelperVariables、getHelperPersistenceStatus、refreshHelperSnapshot、dsh_helper_snapshot_refreshed 事件 |

函数同时提供为全局函数和 TavernHelper 成员。真实会话的事件在同一页面、同会话、同剧情的卡面及后台脚本之间分发，预览仍为本地事件。eventMakeFirst/eventMakeLast 调整整组监听的顺序；eventEmit 逐个等待异步监听，回传每个监听对 JSON 参数的修改，并向发送方传播错误。发送方的对象身份尽量保留，跨 iframe 不共享函数或原型对象。监听返回的 stop() 可单独取消，一次性监听在调用前移除。

eventEmitAndWait 立即同步执行本地监听，然后异步通知其他卡面；它无法同步等待其他 iframe，远端错误显示在发送卡面。需要等待完整事件或读取远端修改时请用 await eventEmit(...)。跨卡面参数限 64 项 / 256 KiB 的 JSON，不接受函数、循环、非有限数字等。单监听等待 15 秒，整次路由限 45 秒；超时不撤销监听已经产生的业务副作用。暂停、关闭或重写卡面会移除其监听，未结束的调用明确失败。

真实会话的 getChatMessages 读取卡面加载或刷新时的历史快照，来源为用户可见的 append 原文，过滤合成上下文，不使用压缩后的模型视图。消息 id 从 0 连续编号，当前消息和最新消息分别由 getCurrentMessageId/getLastMessageId 表示；负数从快照末尾倒数。当前历史预算为 4096 条 / 4 MiB，超量明确失败，分页仍待实现。预览只提供当前文本。

消息包含 message_id/name/role/is_hidden/message/data/extra 和旧卡使用的 mes/swipe_id/swipes；data 读取对应消息变量，extra 读取对应消息的剧情元数据；include_swipes 返回完整已保存页集合及每页的 data/extra，当前页始终反映实际消息变量。返回副本，当前页数组与直接字段也互不共享可变对象。正文批量修改支持独立编辑分支；隐藏状态、其它属性和任意消息写入仍待接入。SillyTavern.getContext 的 chat 包含完整当前快照，其 saveChat 支持现有消息的正文、当前页和完整页数据修改，保留未保存草稿并拒绝过期上下文。

## 消息正文与数据编辑

真实会话卡面与后台脚本可调用 await setChatMessages([{message_id, message}, ...]) 修改用户或角色消息的正文。宿主日志不可原地改写，此操作创建并打开独立编辑分支；原会话保持不变。一次最多 64 条，负数从快照末尾倒数；重复目标、越界、空正文、白名单以外的字段整批拒绝。单条正文限 256 KiB，整批限 1 MiB，修改后的可见历史仍须满足 4096 条 / 4 MiB 快照预算。不变的正文和空数组不会创建分支。

编辑分支保留后续聊天正文与非文本内容，从最早修改楼层起撤销剧情 WAL 派生状态，不自动重新提取事实或发信。被改消息获得新身份，清除旧流式片段的展示来源；修改之后的压缩替换移除，模型重新使用原始消息及新正文，不能继续读取过时摘要。日志位置保持不变，替代记录为可忽略的插件标记；发布前使用真实宿主 Session 校验整个 seed。下一次发信仍可由宿主按需要重新压缩历史。

调用先等待当前变量保存，再核对固定剧情与历史修订；变量保存保留在原剧情，编辑分支依然按上述楼层规则回滚派生变量和事实。生成中、剧情切换、旧快照、坏 WAL 或准备期间有新宿主事件时拒绝编辑。草稿准备与回滚成功后才创建宿主子会话；创建失败清理未绑定剧情。回执送达沙箱确认后才跳转，跳转失败可点击卡面外的“打开消息编辑分支”重试。回执超时不能据此判断未创建，请先检查会话列表，避免重复手动创建分支。

refresh 的 none/affected/all 均接受，但正文编辑最终需要进入新分支，不能保留旧页面同时声称当前会话已改写；正文编辑仍不补发原会话的 MESSAGE_EDITED/MESSAGE_SWIPED 等修改事件；新卡面实际就绪后发送下述显示事件。创建分支后卡面可能卸载，需保存的其它异步任务应先完成。消息 name/role/is_hidden 以及消息插入、旋转仍待适配；原有单条开场白 swipe_id 调用保持可用。

~~~javascript
const id = getLastMessageId();
await setChatMessages([{message_id: id, message: '修订后的角色台词。'}]);
~~~

data 与 extra 可单独或混合正文批量提交；字段为完整普通 JSON 对象，未提供的字段保持不变，空对象清空该表。data 与 getVariables({type:'message', message_id}) 共用同一份消息变量；extra 与变量同存 state/helper.json，一次原子替换，按稳定消息身份定位。变量表、extra 及完整消息页集合各自合计限 1 MiB，状态文件限 4 MiB。

仅数据变化时不创建分支，写入当前剧情最新完成楼层的 WAL；历史文本不变。SDK 提交前等待变量保存，自动携带已确认原值；其它卡面已经修改同一表时整批拒绝覆盖。回执更新消息快照与变量表，等待期间的新本地变量保留并随后串行保存。同页面其它卡面通过现有失效通知刷新。refresh:'none' 可保持 iframe 继续运行；数据修改的 affected/all 在保存后分别重建受影响气泡或当前页面所有已挂载的插件气泡，详见下节；显示完成事件按真实就绪时机发送。

正文与数据混编时，先在分支草稿撤销派生状态，再把显式 data/extra 写到编辑后的消息身份，并记入子会话最新保留楼层 WAL；没有显式提供的数据遵循普通分支回滚规则。这一步失败不会发布子会话或修改来源数据。卡面 SDK 现在接受完整 getChatMessages 返回值：name/role/is_hidden 及旧角色标志保持原值即可往返，修改它们会明确失败。message/mes 与当前 swipes 页、data 与当前 swipes_data 页、extra 与当前 swipes_info 页会归一为相同业务字段；只有一处变化时采用新值，多处出现不同新值时整批拒绝。支持替换页数组、新增或删除页、修改未选中页，以及切换选中页。传入后仍会在宿主端校验规范字段、历史修订和原值，不开放任意消息属性桥。

~~~javascript
const id = getLastMessageId();
const [row] = getChatMessages(id);
await setChatMessages([{message_id: id, data: {...row.data, hp: 10},
  extra: {...row.extra, panel: {tab: 'status'}}}], {refresh: 'none'});
// 此时 getVariables({type:'message', message_id:id}) 与 getChatMessages(id)[0].data 一致。
const [whole] = getChatMessages(id);
whole.data.hp += 1;
await setChatMessages([whole], {refresh: 'none'});
const [pages] = getChatMessages(id, {include_swipes: true});
pages.swipes_data[pages.swipe_id].hp += 1;
await setChatMessages([pages], {refresh: 'none'});
~~~

## 刷新消息显示

真实会话卡面与后台脚本可调用 await refreshOneMessage(id)，或 await setChatMessages([{message_id:id}]) 重建指定消息显示。refreshOneMessage 要求现有的非负整数下标；setChatMessages 的负数下标仍按当前快照倒数。已存在但当前没有挂载插件气泡的消息不做操作，不会自动翻页加载历史。

setChatMessages 的 refresh:'none' 保持现有文档运行，affected（默认）重建本批目标，all 重建同页面当前会话的全部已挂载插件气泡；all 不重启后台脚本，不改写宿主日志。仅 id 的调用不写消息数据，空数组仍不做操作。正文编辑、切页和删除会创建独立分支，仍须导航至该分支；其 none 不改变分支隔离规则。

刷新先等待发起卡面的变量保存，再核对剧情和历史，准备目标气泡的新显示。目标卡面有未保存变量、脚本库、世界书设置、上下文聊天草稿、在途业务请求，或者卡外恢复表单有未提交内容时，整次准备失败并保留旧显示。准备期间暂停目标卡面的新变量和业务写入；失败、取消或超时解除。准备全部成功后先回复发起沙箱，待其确认才替换文档；重绘自身会卸载原脚本，应在调用前完成其它需要保存的异步工作。任意 JavaScript 局部状态和未写入变量的卡内表单不会因重绘而持久化。

重绘使用原有 renderOutputText 路径，正则和模板保持 worker/QuickJS 隔离，已提交回复继续读取模板快照，预览求值不落盘。相同 HTML 也会重建沙箱，使启动代码重新读取已保存数据。渲染失败不撤销此前已成功保存的消息 data/extra。refreshOneMessage 的第二个宿主 JQuery/DOM 目标参数明确拒绝，不提供任意主页面节点访问。CHARACTER_MESSAGE_RENDERED 与 all 刷新产生的 CHAT_CHANGED 按下述规则发送；宿主原生用户气泡及 USER_MESSAGE_RENDERED 仍待适配。

~~~javascript
await setChatMessages([{message_id:0,data:{hp:8}}], {refresh:'none'});
await refreshOneMessage(0); // 先准备，再重建已显示的插件气泡。
// 同一批数据保存后重建当前页面所有插件消息气泡：
await setChatMessages([{message_id:0,extra:{tab:'status'}}], {refresh:'all'});
~~~

## 显示完成事件

已挂载插件消息气泡的全部 HTML 卡面完成初始化和 iframe 渲染事件后，宿主向同页面、同会话、同剧情已注册的监听发送 CHARACTER_MESSAGE_RENDERED(message_id, 'normal')。一条消息中有多个卡面时只发送一次；普通 React 重绘、重复就绪信号、外来窗口和旧事件运行时回执不会重复触发。纯 Markdown 插件气泡在 React 显示提交后发送事件，流式阶段不报完成。关闭或替换旧气泡会使其未完成的事件失效。

setChatMessages 的 refresh:'all' 等到本次所有目标气泡的新显示及其显示监听完成后，再发送一次 CHAT_CHANGED(storyId)。此参数使用本项目的剧情 ID，不是文件路径。refresh:'none' 不触发这些重绘事件；affected/refreshOneMessage 只触发实际重绘的消息显示事件。打开历史不会伪造 MESSAGE_RECEIVED；真实新消息及生成事件见下节。会话切换会取消旧来源，切换专用 CHAT_CHANGED 仍待适配。

宿主事件沿用同剧情 first/last/once 的顺序、JSON 参数预算和监听超时。调用监听前等待本卡已经开始的变量事务结束，然后读取最新剧情快照；冲突或未保存草稿会使该事件明确失败，保留本地数据，不用旧快照继续运行回调。快照准备完成后，宿主重新核验来源和监听是否仍有效，再许可执行；超时、取消和旧运行时的迟到准备不能执行回调。一次性监听在执行许可之前失败或超时时保留，后续事件可重试；如果脚本已经主动取消监听，失败不会将其重新注册；监听本身已经执行后抛错则仍消费一次性监听。失败显示在气泡或卡面中，不撤销监听此前已经保存的业务结果。

~~~javascript
eventOn(tavern_events.CHARACTER_MESSAGE_RENDERED, (messageId, type) => {
  const data = getVariables({type:'message', message_id:messageId});
  // 此时消息显示已就绪，data 来自本剧情的最新已保存快照。
});
eventOn(tavern_events.CHAT_CHANGED, storyId => {
  // 当前页面的 all 重绘已完成，可更新后台脚本中的剧情显示状态。
});
~~~

## 实时消息与生成事件

当前打开的 Tavern 会话通过宿主公开日志窗口订阅增量消息，不主动打开后台会话或加载额外历史。首次加载、分页、重连及日志窗口替换不回放消息事件；替换、切换会话或剧情会取消旧来源的待处理回调。

- GENERATION_STARTED('normal', {}, false)：本页实际观察到轮次开始。
- MESSAGE_SENT(message_id)：实际追加的可见用户消息；合成上下文和模型历史替换不计入。
- MESSAGE_RECEIVED(message_id, 'normal')：本页实际观察到的完整 assistant 消息，等相同轮次正常结束、模板和 WAL 成功收口后，依次通知。工具步骤可产生多条消息，编号对应本项目的连续可见历史下标。
- GENERATION_ENDED(last_message_id)：正常轮次的接收监听完成后通知，末条消息按该结束帧的位置计算；空历史为 -1。
- GENERATION_STOPPED()：已观察到的轮次中断、取消、错误或达到输出上限，不发送该轮的接收或正常完成事件。

回调前刷新当前剧情快照；收口失败、日志损坏或未保存冲突会明确失败。读取屏障保留最近 256 轮的成功/失败回执，不把队列已结束误认成提交成功。消息追加后，原本等待首条消息的后台脚本会自动启动；已运行的脚本保留运行时。新启动脚本不会补收此前发生的历史事件。

这是当前页面的消息/生成通知支持。历史分页 API、跨页面事件、会话选择的 CHAT_CHANGED、消息修改/删除专用事件及 generate/generateRaw 控制接口仍待适配。

~~~javascript
eventOn(tavern_events.MESSAGE_RECEIVED, async (messageId) => {
  const message = getChatMessages(messageId)[0];
  // message 和 getVariables() 已同步到当前剧情；写入仍受正常的冲突与 WAL 校验。
});
~~~

## 删除聊天消息

真实会话的 await deleteChatMessages(messageIds, {refresh}) 一次可删除 0–4096 条可见消息，负数按当前快照倒数。空数组不做操作；重复（包括负数别名重复）、越界、非整数和超过快照上限的请求整批拒绝。普通批量修改仍限 64 条，删除不必为较长聊天拆成多个分支。

删除创建独立分支，保留后续未删聊天及其原消息身份；从最早删除楼层起撤销插件剧情 WAL，再清除被删消息遗留的助手变量、extra 与完整页数据。被删消息及其流式片段以不含原内容的可忽略标记替代，日志 seq 保持连续；assistant 的同一步工具调用与结果成组移除，过时压缩也会清除。其余宿主回合/步骤边界保留，真实 Session 验证 seed 后才发布。配套工具记录仅从分支日志移除，不重跑工具，也不撤销剧情工作区之外既有的副作用。

可删除当前卡面乃至全部可见消息；新分支仍可继续用户输入，下一条 assistant 出现后重新提供消息绑定脚本运行环境。不删除 helper 快照本来就不公开的宿主合成上下文。原会话、摘要和事实保持不变，不能把此操作当作对原始数据的彻底抹除。仅支持独立可识别的消息；同一步出现多个 assistant 记录而无法明确关联工具时，会在发布前拒绝歧义删除。

与正文编辑相同，调用先等待变量保存，核对固定剧情/历史/生成状态，沙箱确认回执后打开分支。refresh:'none' 也需要进入新分支；删除专用 MESSAGE_DELETED 事件仍待适配。上下文 chat 数组的结构修改仍会拒绝，请使用这个专用接口。

~~~javascript
await deleteChatMessages([2, -1]);
// 或一次删除当前快照中的全部可见消息：
// await deleteChatMessages(getChatMessages('0-{{lastMessageId}}').map(row => row.message_id));
~~~

## 完整消息页（swipe）

真实会话的 setChatMessages 支持 swipe_id、swipes、swipes_data、swipes_info。每条消息为 1–64 页；swipes 决定完整正文页数组，提供更短数组会删除尾部页。新增页必须有非空正文；缺省数据保留现有对应页，新页默认为空表。显式提供较短 swipes_data/swipes_info 时，剩余页对应表清空，不能提供超过正文页数的数据。删除当前页且未指定 swipe_id 时，选择剩余页中最近的有效下标。

未改变选中页及其正文的操作在当前剧情原子保存，不触碰模型历史；切换选中下标（即使两页正文相同）或修改当前正文，均创建编辑分支，回滚相应派生状态后写入完整页集合。每页的数据独立保留；当前页的 data 与普通 message 变量 API 共用作用域，切页前已保存的变量带入离开页，回切恢复该页的值。页集合按消息身份保存，重启、继承分支和 WAL 回滚遵循同一剧情边界。多个卡面编辑同一页集合时校验完整旧值，冲突不覆盖。

完整 getChatMessages 返回对象只改变 swipe_id 时，仍带着旧当前页的 message/data/extra；SDK 会保留目标页的数据。若用部分参数显式指定 message/data/extra，则将它们应用到目标页；与显式页数组给出的不同新值冲突时整批失败。首条 assistant 开场白可从角色卡变体初始化页集合，之后的页编辑只保存在剧情，不改共享角色卡资产。

~~~javascript
const id = getLastMessageId();
const [row] = getChatMessages(id, {include_swipes: true});
row.swipes.push('另一种回复。');
row.swipes_data.push({hp: 20});
row.swipes_info.push({label: '另一条路线'});
await setChatMessages([row], {refresh: 'none'}); // 保存未选中页，当前剧情继续运行。
await setChatMessages([{message_id: id, swipe_id: row.swipes.length - 1}]); // 打开切页分支。
~~~

页切换尚不补发 MESSAGE_SWIPED 等专用修改事件；不创建分支的页数据修改遵守上述 affected/all 气泡重绘行为。真实会话的旧 Slash、setChatMessage 和上下文入口已接到相同消息事务；预览仍沿用开场白选择，详见下节。

## 旧接口与原生风格上下文

真实会话中，setChatMessage(text, messageId, {swipe_id, refresh}) 适配为现代批量接口，支持正文、切页及二者组合；空 text 配合 swipe_id 表示只切页。/swipe 的数字为从 0 开始的页下标，left/right（省略方向等于 right）在当前卡面消息的完整页集合中循环；后台脚本的当前消息为其绑定的最新 assistant。这些调用等待真实保存或分支回执，不再直接发旧开场白通知。

SillyTavern.getContext().chat 为可修改草稿，并额外提供 variables（swipes_data）和 swipe_info（swipes_info）别名。saveChat 只提交有变化的行，保留数组与行引用；保存期间继续编辑的字段会保留，其它字段采用确认值。现代与旧页数据别名同时出现不同新值会失败。上下文暂不支持插入、删除、重排或替换 chat 数组。

干净上下文可读取刷新后的快照与普通变量 API 的最新值；未保存草稿不会因 getContext 或刷新而被清空。历史改变、同一消息被其它脚本修改、并发 saveChat 或非法字段均明确失败，保留草稿供备份；此时应先复制修改，再重新打开卡面取得新上下文。正文/切页成功后沿用分支导航，旧页面草稿保留到卸载，不把原聊天伪装成已原地改写。上下文 swipe() 向后切换当前消息的页，陈旧上下文拒绝重定位。

~~~javascript
const context = SillyTavern.getContext();
const row = context.chat[getLastMessageId()];
row.variables[row.swipe_id].hp = 30;
await context.saveChat();
await triggerSlash('/swipe right');
~~~

其它 Slash 命令、管道和完整 ST 上下文仍待适配；未知操作明确失败，不执行宿主 shell。

## 剧情变量与刷新

同步变量 API 先修改卡面快照，差异串行提交给宿主。会话和消息由气泡固定，宿主核对剧情、历史修订、生成状态和每个表的旧值，通过剧情锁与 WAL 保存到 state/helper.json。卡面只在成功回执后显示已保存；await flushHelperVariables() 等待当前变更落盘。冲突、超时、坏日志等明确失败，保留本地数据供备份。

所有作用域均按剧情隔离，包括 global/character/preset；暂不跨剧情共享，也尚未与 EJS 变量合并。消息变量按稳定消息身份存储，公开下标随快照更新。分支继承变量后独立变化，回滚撤销相应楼层写入。script 表供后台脚本使用，extension 目前仅为命名表。

真实会话中，message_id 省略或为 latest 时指快照最新消息，current 指当前卡面；负数倒数，越界拒绝。预览中的 latest/current/-1 都指当前文本。旧备份的 current 表恢复到当前卡面。

updateVariablesWith 支持同步或异步回调；等待期间目标变量被修改、快照被刷新或文档被重写，会拒绝过期提交。deleteVariable 使用 Lodash 路径，例如 hero.hp 或 inventory[0]。getAllVariables 合并 global→character→chat→到当前消息为止的消息表，数组整体替换，不包含 preset/script/extension。

同一页面内，保存成功通知同会话、同剧情的其他卡面；未修改卡面自动刷新，有未保存修改或冲突时保留本地。点击“刷新剧情数据”或调用 await refreshHelperSnapshot() 可主动读取最新状态，成功触发 dsh_helper_snapshot_refreshed。默认拒绝丢弃未保存数据；脚本显式传 {discardUnsaved:true} 才会替换为宿主已保存状态，刷新期间的新修改仍受保护。当前页面的新消息会触发剧情刷新和上述实时事件；跨浏览器页面订阅仍待实现。

备份上限为 1 MiB，不包含尚未写入变量的表单输入。备份、恢复和刷新现位于「Tavern 设置 → 卡片与数据」，显式选择角色及剧情后读取已保存快照。恢复一次最多提交 64 张变化表，经剧情锁、WAL 和原值校验；不重建消息 iframe，成功后通知干净的卡面刷新。角色详情预览始终为临时数据。

## 后台脚本库

隐藏的会话后台运行器按全局、当前绑定预设、角色卡顺序加载脚本库。角色卡读取新版 tavern_helper.scripts（对象或键值对设置）以及旧版 TavernHelper_scripts；预设导入/导出保留 extensions.tavern_helper 设置，全局库存在 library/helper-scripts.json。文件夹和脚本的 enabled 共同决定运行集。每个启用脚本在独立 opaque-origin iframe 中作为 ES module 执行，支持顶层 await；模块导入继续遵守网络白名单与 CORS。

会话不显示脚本按钮或管理面板；启用的脚本在隐藏沙箱中运行，解绑或切换会话卸载对应沙箱。在设置保存脚本后，使用该库的运行器重新加载。运行器需要一条可用角色消息；尚无消息时等待首条消息。关闭交互卡不启动脚本。

“设置 → 脚本”提供全局、预设和角色脚本三个管理入口，可独立选择角色或预设，无需先绑定会话，可新建、编辑、删除和排序脚本及文件夹，并移动脚本到文件夹或顶层。编辑器左侧支持搜索、选中状态和启用状态，右侧将源码与说明、初始变量、按钮设置分组；窄屏自动切换为单栏。支持持久启用开关；没有已有脚本的角色也能进入管理。保存后留在当前脚本继续编辑，变量格式错误会定位到对应脚本，关闭前保护未保存草稿。导入接受单脚本、脚本树或带 scripts 的 JSON，先放入草稿，点击“保存并重新加载”后才写入对应资产并重启当前运行器。导出遵守每个脚本的变量/按钮导出选项。

脚本库是共享资产，保存会影响使用相应库的会话后续加载。普通预设条目编辑保留最新脚本库，显式重新导入预设可以替换脚本设置；删除预设后旧脚本编辑器不能将它重新创建。编辑器保留未保存草稿，保存冲突或无效 JSON 时保留输入；旧修订不能覆盖另一个编辑器的新内容。初始变量的修改不会覆盖已经存在的剧情 script 表。其他会话的运行器需重新加载才使用新脚本。

脚本专属接口为 getScriptId/getScriptName/getScriptInfo/replaceScriptInfo、getScriptButtons/getButtonEvent/replaceScriptButtons/updateScriptButtonsWith/appendInexistentScriptButtons。按钮出现在该脚本沙箱内，点击触发 getButtonEvent(name) 对应事件。动态按钮和说明通过脚本库保存接口写回本脚本所属资产；运行变量仍不写回。真实会话卡面及后台脚本内的 getScriptTrees({type:'global'|'preset'|'character'}) 返回对应库的独立快照，没有绑定预设时该库为空。

脚本 data 只初始化尚不存在的剧情 script 变量表；{type:'script'} 的缺省 script_id 是当前脚本。重启不补回已删除字段，运行变量不写回共享角色资产。单脚本正文限 256 KiB，每个库限 4 MiB / 128 个脚本，运行快照的三类库合计限 4 MiB，每会话最多同时启动 32 个。跨库启用脚本的 ID 重复时拒绝启动，避免串用变量或事件；冲突时仍保留管理入口，便于关闭冲突脚本。加载途中更换绑定会拒绝旧脚本包。

```javascript
// 可直接作为角色卡后台脚本正文；在脚本按钮设置中添加“增加”。
eventOn(getButtonEvent('增加'), errorCatched(async () => {
  updateVariablesWith(v => ({ ...v, count: (v.count || 0) + 1 }), { type: 'script' });
  await flushHelperVariables();
  toastr.success('已保存');
}));
```

## 脚本库写入与重载

replaceScriptTrees 同步替换本地脚本树，updateScriptTreesWith 支持同步或异步 updater；两者随后串行提交共享资产。等待异步 updater 时如果树已改变或卡面被重写，会拒绝过期更新。每批保存使用上一批成功回执的修订号，不会覆盖其它编辑器的新版本。预览没有共享资产写入能力。

await flushHelperScripts() 等待当前脚本库修改落盘；保存成功后沙箱确认回执，宿主才通知本会话后台运行器重载。因此修改或删除运行脚本可能结束它当前的异步工作。保存失败保留本地树，并显示错误；getScriptTrees 可取回草稿供导出。回执超时后的明确重试为 flushHelperScripts({retry:true})，宿主对相同目标值幂等；冲突不会被强行覆盖。

refreshHelperScripts() 读取当前绑定库的快照，默认拒绝丢弃未保存修改；显式 {discardUnsaved:true} 才可替换草稿，刷新途中产生的新修改仍保留。后台运行器在同页面同会话的保存确认后重载，其它普通卡面的库快照可用此函数刷新。更新运行资产不保证任意其它异步任务完成，脚本应先等待需要保留的变量保存。

宿主固定 sessionId 并根据绑定选择库，脚本只传 global/preset/character 枚举。storyId 与绑定修订令牌同时校验，且绑定锁覆盖校验到资产保存，加载后换绑的旧卡面不能把代码写到新预设。此桥不提供任意资产 ID、文件路径或 remote 方法。

## 世界书读写

真实会话卡面与后台脚本可使用现代 worldbook API 读写公共库、当前角色内嵌书及当前聊天世界书；角色预览不提供此持久接口。目录与绑定 getter 同步返回加载时的快照，条目操作为 Promise；await refreshHelperWorldbooks() 可刷新目录和当前绑定。

getWorldbookNames() 返回公共库文件标识、存在时的 @dsh/character（当前角色内嵌书），以及当前剧情保存的所有私有书标识。@dsh/chat 固定代表主私有书，其它书使用 @dsh/chat/<id>；它们不会随当前选择改变含义。公共书也接受唯一匹配的原始书名；重名时须使用目录标识。getCharWorldbookNames('current') 返回主绑定及 additional，getChatWorldbookName('current') 返回活动私有书标识或 null；不能查询其它角色/聊天。getOrCreateChatWorldbook('current', '可选显示名') 返回已有活动书；没有活动书时按显示名复用唯一私有书或新建。脚本应使用返回标识读写。

replaceWorldbook 完全替换条目，updateWorldbookWith 支持同步/异步 updater，createWorldbookEntries 自动分配不冲突的数值 UID，deleteWorldbookEntries 的 predicate 必须同步返回布尔值。回调只在沙箱中运行，宿主只接收经过校验的 JSON。RegExp 关键词转换为原生 /source/flags 文本；读取返回文本，正则实际匹配仍由隔离 worker 完成。旧字符串 UID 在写回时保留，避免破坏原生计时器/变化层引用。

写入采用读取快照的修订号，冲突时明确失败；调用方应重新读取、合并再提交。保存报错不代表文件一定未写入：公共书即使回执失败也会使缓存失效；内嵌书相同目标重试会补齐卡片镜像，不因资产文件已写成功就提前确认。目录刷新或卡面关闭会拒绝仍在等待的旧 updater。共享书与内嵌书属于角色资产，不记剧情 WAL；聊天书只写当前 story，归入当前卡面完成楼层的 WAL，生成中、已回滚楼层和损坏日志拒绝写入。分支与回滚沿用剧情文件快照。设置面板需刷新才能展示脚本修改，render 选项目前没有额外渲染调度。

每本书限 2000 条 / 8 MiB JSON，单条正文限 100000 字符，公共目录限 512 本，每卡最多 4 个在途请求。保留名称或重复原始 UID、无效字段及超量数据明确报错，不静默丢条目。当前引擎没有向量触发，已有 vectorized 标记可保留，新增向量条目明确拒绝。每个剧情最多保存 64 本私有书，活动与闲置书合计限 32 MiB。旧全局世界书设置适配为当前会话覆盖，详见下节。

~~~javascript
const book = await getOrCreateChatWorldbook('current');
await createWorldbookEntries(book, [{
  name: '已知门锁', content: '北门需要银钥匙。',
  strategy: { type: 'selective', keys: ['北门'] }
}]);
~~~

## 世界书绑定

rebindGlobalWorldbooks(names) 修改当前会话的全局书选择；rebindCharWorldbooks('current', {primary, additional}) 修改当前会话角色主书与附加书。primary 为 null 时明确关闭主书，@dsh/character 选择内嵌书；附加书来自公共库。它们适配为会话配置，不修改其它会话，也不记剧情 WAL。会话绑定面板提供无主书与附加书选择；脚本成功修改后会刷新绑定显示。每组选择最多 64 本，绑定请求 JSON 限 16 KiB。

rebindChatWorldbook('current', name) 选择当前剧情私有书；传入公共书或内嵌书时首次复制为剧情私有书，以后切回同一来源会复用副本，保留剧情修改。共享来源后续修改不会自动覆盖副本。传 null 解绑并保留所有书，deleteWorldbook 才删除指定书。活动内容、选择和闲置书一并存入 assets/chat-lorebook.json，通过一次楼层 WAL 写入，分支独立继承、回滚整体恢复。面板编辑保留闲置书；解绑后再用面板编辑会创建新活动书，保留先前主书。

绑定操作返回后，同一卡面的绑定快照立即更新，排队请求使用最新令牌；绑定改变会拒绝尚未完成的旧条目 updater。其它卡面可调用 refreshHelperWorldbooks 刷新。保存报错可能发生在文件已经写入之后，应先刷新绑定与内容，再合并重试。全局/角色配置修改可在生成中保存，但只在下一轮应用；已冻结的当前轮提示词计划保持不变。聊天切换及内容写入在生成中拒绝。

## 旧 lorebook 接口

旧目录/当前角色/当前聊天查询，以及世界书条目读取、完全替换、updater、按 UID 局部更新和批量增删，复用现代世界书桥。无需额外授权窗口或另一份存储，版本冲突、生成中拒写、剧情 WAL、回滚和关闭卡面后的迟到更新保护一致。getOrCreateChatLorebook('可选显示名') 返回当前剧情书别名。

getLorebookEntries 返回旧字段，例如 comment、type、keys、filters、position、delay_until_recursion；at_depth 会转成 at_depth_as_system/assistant/user。display_index、继承开关、组权重、计分开关和定时效果会写回原生字段。现代 outlet 位置作为兼容扩展原样返回，避免旧 updater 把它改到其它位置。同 UID 的现代 extra 数据会保留。

setLorebookEntries 仅更新指定 UID 与字段，其它条目保留；重复/不存在 UID 整批拒绝。replaceLorebookEntries 完全替换，未提供的旧字段恢复默认值。updateLorebookEntriesWith 支持异步 updater，返回旧条目数组；createLorebookEntries 返回 {entries,new_uids}，deleteLorebookEntries 返回 {entries,delete_occurred}。未知字段、函数、访问器、稀疏 UID 数组和超量输入明确拒绝。

getLorebookEntries 的可选 {filter:{...}} 按指定字段相等筛选，数组比较完整内容；filter:'none' 不筛选。getCharLorebooks({name:'current',type:'all'|'primary'|'additional'}) 仍只查询当前角色；primary 模式清空返回的 additional，additional 模式令 primary 为 null。

条目 use_group_scoring 的 same_as_global/true/false 对应继承/开启/关闭；启用计分且分数低于整组最高分的候选会先淘汰，显式关闭者保留，再按 override 与 group_weight 选择。同分组保留加权选择。此行为核对了 [SillyTavern 组计分实现](https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/public/scripts/world-info.js)，仍由项目的隔离世界书扫描执行。

setCurrentCharLorebooks 支持只传 primary 或 additional，在请求轮到执行时合并当前绑定；setChatLorebook(name 或 null) 复用现代聊天绑定行为。旧 getLorebookSettings/setLorebookSettings 的当前会话适配见下节。

## 旧世界书设置

getLorebookSettings() 同步返回独立设置快照；setLorebookSettings(partial) 同步修改本地快照，并将部分字段串行保存到当前会话绑定。它不修改其它会话或项目全局设置；未覆盖字段继续跟随项目设置，分支继承配置后可独立修改。selected_global_lorebooks 与本次设置在同一次绑定保存中应用；名称不存在或其它字段无效时整批拒绝。会话配置不记楼层 WAL，修改只在下一轮提示词计划中生效。

await flushHelperWorldbookSettings() 等待当前设置保存，getHelperWorldbookSettingsStatus() 返回 pending、unsaved 和 error。异步保存失败在卡面显示，保留本地设置草稿并停止后续设置提交；用 getLorebookSettings() 备份，refreshHelperWorldbooks({discardUnsaved:true}) 明确放弃草稿、读取真实状态后再应用修改。默认刷新拒绝丢弃草稿；保存中不能刷新，刷新中不能设置。写入报错可能发生在绑定文件已保存之后，需先读取确认。

| 旧字段 | 本项目效果 |
| --- | --- |
| selected_global_lorebooks | 当前会话公共世界书选择 |
| scan_depth / include_names | 消息扫描深度与姓名前缀 |
| min_activations / max_depth | 激活数不足时逐条扩展历史扫描 / 扩展深度上限 |
| context_percentage / budget_cap | 百分比预算 / 固定 token 预算，沿用项目的稳定段豁免与窗口基数限制 |
| recursive / max_recursion_steps | 递归开关 / 含首次扫描、递归及历史扩展的总扫描轮数 |
| case_sensitive / match_whole_words | 大小写 / 整词匹配，条目设置可覆盖 |
| insertion_strategy | evenly、character_first、global_first 对应项目来源排序 |
| use_group_scoring / overflow_alert | 默认组计分 / 预算溢出日志告警 |

最少激活行为核对了 [SillyTavern 扫描状态与深度设置](https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/public/scripts/world-info.js)，由本项目隔离引擎独立执行。min_activations 为 0 时关闭扩展；max_depth 为 0 时允许扫到现有历史，最多 1000 条。max_depth 是扩展上限，不缩小初始 scan_depth；条目自己的扫描深度保持不变。扩深和递归共用一次求值，定时器只推进一次，概率失败不因重复扫描而重新掷骰，仍遵守分组与预算停止条件。项目既有预算语义保持：固定预算优先于百分比，稳定常驻段不计入本轮世界书预算。

设置请求限 16 KiB；扫描深度、扩深上限和总扫描轮数为 0–1000 整数，最少激活数为 0–2000，固定预算为 0–1000000，百分比为 0–100。开关严格接受布尔值，未知字段、函数、访问器及超量队列明确失败。项目设置面板可配置最少激活与扩深上限；会话绑定面板显示是否存在脚本覆盖，点击“恢复跟随全局设置”并保存绑定可清除所有引擎覆盖。

~~~javascript
setLorebookSettings({scan_depth: 2, min_activations: 3, max_depth: 20});
await flushHelperWorldbookSettings();
~~~

## MVU 手动解析与显式保存

每个沙箱内置本地 Mvu 对象，await waitGlobalInitialized('Mvu') 后可使用。getMvuData(options) 同步读取现有变量表的独立副本；replaceMvuData(data, options) 修改本地快照并等待现有剧情 CAS/WAL 保存回执。parseMessage(text, oldData) 按副本计算，不自动落盘、不编辑正文、不创建分支；无命令时也返回副本。isDuringExtraAnalysis() 返回 false，本适配未发起额外模型解析。

~~~javascript
await waitGlobalInitialized('Mvu');
const old = Mvu.getMvuData({type: 'message', message_id: getCurrentMessageId()});
const next = await Mvu.parseMessage("_.add('角色.好感度', 2); // 完成约定", old);
await Mvu.replaceMvuData(next, {type: 'message', message_id: getCurrentMessageId()});
~~~

初始数据需含 stat_data 对象。普通 JSON 数据支持 set、add、insert、delete、move，以及 assign/remove/unset 别名；JSONPatch 支持 add/replace/remove/move/copy/test 和 delta。set 的三参数旧值用于兼容解析，不作为并发断言；并发保护仍由变量保存事务负责。字符串使用单/双引号，支持对象、数组及裸对象键字面量；不会执行数学表达式、函数或模板字符串。add 限有限数字；缺失路径、非法删除、污染字段、非 JSON 值和超量数据整批拒绝，原始输入不变。文本与参数限 256 KiB、单次 256 条命令、64 层路径、总输出 1 MiB。事件参数另受现有 256 KiB 总预算限制。

解析依次等待 VARIABLE_UPDATE_STARTED、COMMAND_PARSED、mag_command_parsed_for_zod、mag_command_parsed_ended_for_zod，应用剩余命令后等待 VARIABLE_UPDATE_ENDED、mag_variable_update_ended_for_zod。回调对变量对象和命令数组的修改经现有同剧情事件路由回传；Zod 回调可自行处理并清空命令。函数与 schema 闭包始终留在各自沙箱。任一监听失败或运行时关闭，解析失败且不自动保存。display_data 保留解析前的未变路径，delta_data 记录命令变化；结束钩子可以删除这两项。

经典 MVU 的 schema 树、扩展性与模板元数据尚未实现；解析结果只允许无 schema 或 Zod 特定标记“没有用别管这个”，不支持的规则明确失败。临时 stat_data.$internal 不得保存。会话启用下述原生自动更新后会触发 VARIABLE_INITIALIZED；BEFORE_MESSAGE_UPDATE 正文改写及状态栏占位替换仍待适配。不要同时加载依赖 parent.Mvu 的原版框架来替代本地对象；任意 initializeGlobal/其它 waitGlobalInitialized 名称及跨沙箱同步对象共享尚未支持。

行为按 [MVU 公开接口实现](https://github.com/MagicalAstrogy/MagVarUpdate/blob/master/src/function/global/index.ts) 与 [变量事件和命令实现](https://github.com/MagicalAstrogy/MagVarUpdate/blob/master/src/function/update_variables.ts)独立适配；这不是整套 MVU 卡片兼容完成的声明。

## 原生 MVU 自动更新

在会话绑定中启用“原生 MVU 自动更新”，并保持该会话页面打开。默认关闭；需要交互卡总开关开启，会话面板只能在空闲且没有活动楼层时启用。生成过程中恢复全局交互卡总开关时，尚未建立的 MVU 初始化延后到当前正常 stop，不向之前的楼层补写。后台脚本的模块顶层、DOM ready 回调和初值保存完成后才认领任务；额外异步初始化应在模块顶层 await。启用脚本尚未就绪时会等待，防止漏掉其变量规则。没有后台脚本时也可运行普通 MVU 命令。

初次启用以当前最新的完整角色消息为锚点，不回写更早楼层。当前锚点已保存 stat_data 时沿用它且不重放该消息的加减命令；只有从前条/世界书构造新锚点时才解析当前回复。初始化读取当前绑定的公共世界书与角色主/附加世界书中注释含 [initvar] 的条目，支持普通 JSON/YAML；开场白的 <initvar> 可替代角色书初值。支持对象合并、UID 初始化记录及旧书名记录；初始化模板 EJS、不同值的重叠数组和 classic schema 规则会明确失败。初始元数据可由 VARIABLE_INITIALIZED 的沙箱 Zod 钩子消费，最终保存不得含不支持的元数据。

后续实际正常 stop 回复在宿主结束当前轮前排入任务，沿用该轮 WAL；变量与完成回执写在同一个剧情文件中。超时、脚本异常、页面断开或停止等待会保留任务，下一轮在旧任务完成前不会用过期变量生成。异常输入/文件、绑定或脚本修订冲突拒绝提交。无空闲窗口的队列兜底保留原输入 ID、目标与顺序；取消后可能需要从原生队列继续或用下一条真实输入唤醒，不伪造用户消息。

自动事件监听先刷新为本次任务快照，钩子应修改传入的数据/命令参数。任务期间普通剧情变量、聊天世界书和消息写入受事务门控；跨沙箱函数仍不传输。网络提交失败保留计算结果，原租约仍有效时重试仅补交结果。租约结束或宿主重启后，页面先用任务摘要核对持久完成回执；WAL 验证/恢复成功后才确认完成。仍未完成的旧租约会显示“重新读取并运行 MVU 任务”，点击后从新快照重新计算。关闭或重建沙箱后，未提交钩子可能再次执行，因此外部网络副作用不具备跨崩溃“只执行一次”保证。任务完成后其他卡面刷新持久变量。

普通开关关闭只暂停自动处理并保留任务。若停用期间已经产生后续楼层，旧任务无法向早期楼层补写，可在会话绑定面板明确选择“放弃待处理任务并关闭自动 MVU”。此入口在全局交互卡关闭时仍可用；确认后只清未完成队列，保留消息、全部已保存变量与完成回执。它在最新合法所属楼层写入专属恢复记录，不把任务伪装成已完成；坏 WAL 或未收口模板事务会阻止操作。再开启后，已有初始化状态继续处理后续正常回复；尚未初始化的剧情从最新完整消息建立初值。

从被截断、尚未提交变量的回复继续写时，目前不能自动合并跨消息的半条 MVU 命令，会明确拒绝并提示重新生成完整回复；正常完成回复之后的续写只处理新增正文。

下一轮提示词的 EJS getvar/getMessageVar、variables.stat_data 与变量宏读取同剧情可见消息 stat_data 的独立只读视图；本轮计划冻结后保持不变，下一轮才重新读取。历史被模型摘要压缩后，默认当前变量仍与后台下一条回复的继承基准一致；显式 withMsg/end 只读取模型可见的消息身份，不把被压缩原文塞回提示词。模板赋值、删除、递增及通过引用修改该视图会报错；不会把它复制进另一份模板变量存储。

## 变量 schema 编辑器（底层兼容能力）

普通卡面不再自动挂载变量工具。设置中的备份恢复只校验 JSON 和剧情提交边界，不调用第三方 iframe 注册的 schema。以下编辑器是保留的隔离实现，当前产品界面不提供入口。

registerVariableSchema(schema, {type: 'global'|'preset'|'character'|'chat'|'message'}) 为当前 iframe 的变量工具注册结构。展开变量工具、选择作用域并载入 JSON 后，可校验、保存或丢弃草稿。消息目标支持明确下标、负深度、current 和 latest；载入后固定目标，避免历史增长期间写到另一楼层。所有作用域仍按当前剧情隔离。

校验调用原 schema 的 safeParseAsync，保留 Zod default/coerce/transform/refine 行为，最长等待 15 秒。只有编辑器保存应用转换结果，getVariables/replaceVariables 等程序操作不受 UI schema 约束。结构与回调不会序列化到主页面，也不会自动影响其它 iframe 或主面板；例如后台脚本注册的结构在该脚本的变量工具里使用。

异步校验期间变量、历史、schema 或输入变化会阻止覆盖。保存等待剧情回执，失败保留文本和本地变量供备份；有草稿或校验/保存进行中时拒绝消息重绘。丢弃草稿重新载入当前本地快照；持久层冲突需先备份并通过剧情刷新流程读取真实状态。预览保存仅在该预览内有效。

## 尚待适配及宿主边界

- MVU 完整更新链路仍待补齐；脚本库快照刷新与剧情变量刷新是独立操作。
- 世界书向量触发、正则、预设及角色资产 CRUD，更多消息属性、插入和旋转、生成控制、提示词注入、工具注册和更多 Slash 仍待接入。
- tavern_events 常量可供注册，但不会伪造宿主消息或生成事件。跨 iframe schema 管理和模块导入映射尚未移植。
- 不开放主窗口 DOM、parent.$、parent.TavernHelper、Node、任意 remote 调用或文件路径桥。iframe 保持 sandbox="allow-scripts"，没有 allow-same-origin；默认禁止 connect 与外部脚本，用户已有网络白名单仍生效。
- 图片、字体和原生 HTML 音频遵守现有 CSP；酒馆助手全局播放器和播放列表尚未接入。
- document.write 重写先清理旧监听，再注入可信 CSP、本地依赖和运行接口；变量与最新快照保留。reloadIframe 仍提示使用宿主恢复入口。

版本接口返回 0.1.0-dsh-card，不冒充上游版本。当前验证结果不代表所有酒馆助手角色卡已能直接运行。


## 脚本运行诊断与受限选项

设置 → 脚本显示当前页面已挂载会话的逐脚本启动状态、运行错误和原生 MVU 任务错误。成功通知不会被当作脚本失败；原生任务只有在全部脚本就绪后执行，失败任务可在设置中重试。管理入口不再出现在会话消息里。

纯 `MagicalAstrogy/MagVarUpdate/artifact/bundle.js` 官方 jsDelivr 导入入口交给原生 MVU 适配器。仍须在会话绑定中启用原生 MVU；自定义框架代码不自动替换。卡面提供 Zod 4 模块命名空间，兼容 `z.object` 和 `z.z.ZodObject`。原版依赖父窗口 Vue、SillyTavern 或主页面 DOM 的脚本须迁移，不能据此认为完整 SillyTavern 已被实现。异步初始化应使用模块顶层 await，确保注册规则后才发出就绪回执。MVU 更新钩子应修改传入的变量对象，由原生任务最终统一提交；不要在钩子内再次显式保存同一消息变量。

后台脚本可调用 `setMessageChoices(messageId, [{label, text}])` 为当前快照中的角色消息设置纯文本选项。最多 32 项，label 最多 128 字符，text 最多 1024 字符；空数组清除当前脚本选项。宿主核对来源窗口、运行时、剧情、历史修订和可见角色消息，下次同脚本发布替换旧列表，卸载清除。选项只在对应消息下方出现；可信按钮点击后经宿主公开 SessionInput.setDraft 填入当前会话草稿，保留已有文字，连续点选替换末尾上次填入的选项。含引用、已认领指令或提交期间拒绝覆盖。此桥不发送消息，不传递 HTML、代码或 DOM 权限，也不允许脚本直接读写输入框。


原生 MVU 会话中的角色卡若有启用的精确 `<StatusPlaceHolderImpl/>` 展示正则（无限定深度），展示层会在缺少占位符时补出卡片原状态栏。已有占位符不重复添加，关闭交互卡或原生 MVU 后不补位；不修改聊天原文、提示词、模板缓存或变量。旧面板的 window.chat 读取当前沙箱消息快照副本。卡片自行发出的 iframe-resize / resizeIframe 高度回执经来源窗口校验并限制在 80–8000 像素，避免隐藏抽屉撑大卡面。


### 前端卡兼容回归（2026-09-09）

- 允许交互的已绑定消息即使只有纯文本，也返回当前剧情助手快照，使后台脚本发布的消息选项可以显示；独立预览和关闭交互的消息不开放该上下文。脚本库与世界书仍按 HTML 卡面的需要加载。
- `dsh_helper_snapshot_refreshed` 只在快照内容变化时发出；重复读取同一快照不会继续触发订阅者，变量与历史修订变化仍会通知。
- 自动测高不再把根元素的视口高度作为内容下限，支持卡面折叠后缩小；内容扩展和原有的有界旧版高度通知保持可用。

本轮验证覆盖真实剧情文件的纯文本渲染、快照刷新事件、iframe 尺寸反馈、消息交互、MVU 执行与中英文键一致性。实际页面验证了现有状态栏显示和沙箱配置。直接访问父页面 DOM 的旧卡按钮、仅在首次加载时绘制且不订阅数据变化的第三方状态栏，仍需要按各卡逻辑适配，不能据此宣称全部前端卡兼容。
