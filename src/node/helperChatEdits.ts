/** 固定剧情的消息批量编辑：数据原子保存，正文在独立分支回滚后绑定显式数据，不自动发信。 */
import {assertHelperMvuWritable} from './helperMvu.js'
import {join} from 'node:path'
import {WorkspaceFs} from '../state/workspaceFs.js'
import {Wal} from '../state/wal.js'
import type {HelperSwipeSet} from '../core/helperSwipes.js'
import {helperJson,helperTable} from '../core/helperRuntime.js'
import {loadHelperState,saveHelperState,serializeHelperState,type HelperState} from '../state/helper.js'
import type {Context} from '@deepseek-ai/cordis'
import type {Session} from '@deepseek-ai/dsh-session'
import {isSyntheticUserText} from '../core/dshPrompt.js'
import {isTavernGreetingEvent,sessionHasUserMessage} from '../core/greetingLog.js'
import {parseHelperMessageEdits,type HelperMessageEditRequest,type HelperMessageEditResult} from '../core/helperChatEdits.js'
import {getHelperSnapshot,helperHistoryOf,helperHistoryRevision,withHelperStoryWrite} from './helperRuntime.js'
import {forkEditedHistory,swipeGreetingLocked} from './floors.js'
import {editedHistorySeed} from './helperChatSeed.js'
import {withWorkspaceLock} from '../state/workspaceLock.js'
import type {TavernState} from './state.js'
import type {HelperFrameWriteGuard} from '../core/helperFrame.js'

/** 仅在前置位置增删未选中页导致当前页下标顺移且当前页与后缀全部不变时不算切页；同正文追加、改写后缀或删尾并切换仍须建分支。 */
function isPureShiftBeforeActive(before:HelperSwipeSet,after:HelperSwipeSet,equal:(a:unknown,b:unknown)=>boolean):boolean{
  const delta=after.active-before.active
  if(delta===0)return false
  if(!equal(after.pages[after.active],before.pages[before.active]))return false
  // 活跃页之后的全部后缀页必须完全一致；若单次调用同时改写后缀或删尾，不能当作纯前置顺移。
  const beforeSuffix=before.pages.slice(before.active+1),afterSuffix=after.pages.slice(after.active+1)
  if(beforeSuffix.length!==afterSuffix.length||!beforeSuffix.every((page,index)=>equal(page,afterSuffix[index])))return false
  // 旧 active 及之前的全部页均原位未变，说明调用方是在后续位置增删并显式切换到另一页，并非前置顺移。
  if(after.pages.length>before.active&&before.pages.slice(0,before.active+1).every((page,index)=>equal(page,after.pages[index])))return false
  const isSubsequence=(shorter:HelperSwipeSet['pages'],longer:HelperSwipeSet['pages']):boolean=>{
    let cursor=0
    for(const item of longer)if(cursor<shorter.length&&equal(item,shorter[cursor]))cursor++
    return cursor===shorter.length
  }
  if(delta>0){
    return after.pages.length-before.pages.length===delta&&isSubsequence(before.pages.slice(0,before.active),after.pages.slice(0,after.active))
  }
  return before.pages.length-after.pages.length===-delta&&isSubsequence(after.pages.slice(0,after.active),before.pages.slice(0,before.active))
}

export async function editHelperMessages(ctx:Context,state:TavernState,sessionId:string,messageId:number,request:HelperMessageEditRequest,beforeWrite?:HelperFrameWriteGuard):Promise<HelperMessageEditResult>{
  const edits=parseHelperMessageEdits(request.edits),initial=await state.loadStoryBinding(sessionId)
  if(!initial?.storyId||initial.storyId!==request.storyId)throw new Error('消息编辑剧情绑定已改变')
  const ws=await state.storyWorkspace(initial.cardId,initial.storyId)
  return withWorkspaceLock(ws.fs.root,()=>withWorkspaceLock(state.paths.sessions,async()=>{
    const binding=await state.loadStoryBinding(sessionId,{waitForAdoption:false}),source=ctx.sessions.get(sessionId as Session['id'])
    if(!source)throw new Error('消息编辑需要当前会话在线')
    if(!binding||binding.cardId!==initial.cardId||binding.storyId!==request.storyId)throw new Error('消息编辑剧情绑定已改变')
    if(!state.config.interactiveCards||binding.interactiveCards===false)throw new Error('交互卡已关闭')
    await assertHelperMvuWritable(state,sessionId,{waitForAdoption:false})
    const snapshot=await getHelperSnapshot(ctx,state,sessionId,messageId,{waitForAdoption:false})
    if(!snapshot.writable)throw new Error('生成期间不能编辑聊天消息')
    if(snapshot.historyRevision!==request.historyRevision)throw new Error('聊天历史已改变，请刷新后重试')
    const sourceSeq=source.seq,events=source.snapshotEvents(),history=helperHistoryOf(events,{char:'',user:''}),changed=new Map<number,string>(),deleted=new Set<number>(),deletedIdentities=new Set<string>(),deletedEntries:{seq:number;identity:string}[]=[],seen=new Set<number>()
    const turnBySeq=new Map<number,number>()
    for(let i=0,currentTurn=0;i<events.length;i++){
      const event=events[i]!
      if(event.type==='turn/start')currentTurn=event.data.turn
      else if(event.type==='assistant/message')turnBySeq.set(event.seq,event.data.turn)
      else if(event.type==='user/message')turnBySeq.set(event.seq,currentTurn)
    }
    if(helperHistoryRevision(history)!==snapshot.historyRevision)throw new Error('读取快照期间聊天历史已改变')
    const verify=async()=>{
      const current=await state.loadStoryBinding(sessionId,{waitForAdoption:false}),live=ctx.sessions.get(sessionId as Session['id'])
      if(live!==source||source.seq!==sourceSeq||current?.storyId!==binding.storyId||current?.cardId!==binding.cardId||current.greetingIndex!==binding.greetingIndex
        ||!state.config.interactiveCards||current.interactiveCards===false||source.snapshotEvents().length!==events.length||state.openFloors.has(sessionId))throw new Error('消息编辑期间会话已改变')
      if(helperHistoryRevision(helperHistoryOf(source.snapshotEvents(),{char:'',user:''}))!==snapshot.historyRevision)throw new Error('消息编辑期间聊天历史已改变')
      beforeWrite?.(current)
    }
    const expected=parseHelperMessageEdits(request.before??[]),saved=await loadHelperState(ws.fs)
    const expectedById=new Map(expected.map(row=>[row.message_id,row]))
    beforeWrite?.(binding)
    const equal=(a:unknown,b:unknown)=>JSON.stringify(helperJson(a))===JSON.stringify(helperJson(b))
    const metadata:{seq:number;data?:Record<string,unknown>;extra?:Record<string,unknown>;pages?:HelperSwipeSet}[]=[]
    const consumed=new Set<number>()
    for(const edit of edits){
      const index=edit.message_id<0?history.length+edit.message_id:edit.message_id,target=history[index]
      if(!target||seen.has(index))throw new Error('消息序号越界或重复指向同一条消息')
      if(edit.delete){seen.add(index);deleted.add(target.seq);deletedIdentities.add(target.identity);deletedEntries.push({seq:target.seq,identity:target.identity});continue}
      const currentBook=snapshot.messages[index]!.swipe??{active:0,pages:[{message:target.message,data:snapshot.messages[index]!.data,extra:snapshot.messages[index]!.extra}]}
      const selected=edit.pages?.pages[edit.pages.active]
      if(selected)for(const key of ['message','data','extra'] as const)if(edit[key]!==undefined&&!equal(edit[key],selected[key]))throw new Error('选中页与消息字段不一致')
      const text=selected?.message??edit.message
      if(text!==undefined&&target.role==='user'&&isSyntheticUserText(text))throw new Error('用户正文不能改为宿主保留的合成指令')
      const pageSwitched=edit.pages!==undefined&&edit.pages.active!==currentBook.active&&!isPureShiftBeforeActive(currentBook,edit.pages,equal)
      seen.add(index);if(text!==undefined&&(target.message!==text||pageSwitched)){changed.set(target.seq,text);deletedIdentities.add(target.identity);deletedEntries.push({seq:target.seq,identity:target.identity})}
      if(edit.data!==undefined||edit.extra!==undefined||edit.pages!==undefined){
        const old=expectedById.get(edit.message_id)
        if(!old||old.message!==undefined||Object.hasOwn(old,'data')!==Object.hasOwn(edit,'data')||Object.hasOwn(old,'extra')!==Object.hasOwn(edit,'extra')||Object.hasOwn(old,'pages')!==Object.hasOwn(edit,'pages'))throw new Error('消息数据编辑缺少原值，请刷新后重试')
        consumed.add(old.message_id)
        if(edit.pages&&!equal(currentBook,old.pages)&&!equal(currentBook,edit.pages))throw new Error('消息页已被另一卡面修改，请刷新后重试')
        for(const field of ['data','extra'] as const){
          if(edit[field]===undefined)continue
          const current=field==='data'?saved.scopes[JSON.stringify(['message',target.identity])]??{}:saved.extras[target.identity]??{}
          if(!equal(current,old[field])&&!equal(current,edit[field]))throw new Error('消息数据已被另一卡面修改，请刷新后重试')
        }
        metadata.push({seq:target.seq,...(selected?{data:selected.data,extra:selected.extra,pages:edit.pages}:{}),...(edit.data!==undefined?{data:edit.data}:{}),...(edit.extra!==undefined?{extra:edit.extra}:{})})
      }
    }
    if(consumed.size!==expected.length)throw new Error('消息编辑原值与目标不匹配')
    // 仅有开场白且未改写页内容/附加数据的纯切页（如交互卡 `/swipe right`、setChatMessages 仅切 swipe_id）：
    // 在已持有的 storyRoot → sessions 双锁内直接调用 swipeGreetingLocked，消除放锁 TOCTOU 竞态，
    // 并同步更新 greetingIndex、分支标题与开场白变体数量/正文复核。
    if(edits.length===1&&deleted.size===0&&changed.size===1&&history.length===1&&!sessionHasUserMessage(events)){
      const soleEdit=edits[0]!,soleTarget=history[0]!,soleEvent=events.find(event=>event.seq===soleTarget.seq)
      const currentBook=snapshot.messages[0]!.swipe
      const selected=soleEdit.pages?.pages[soleEdit.pages.active]
      if(soleEvent&&isTavernGreetingEvent(soleEvent)&&saved.swipes?.[soleTarget.identity]===undefined
        &&soleEdit.pages!==undefined&&currentBook!==undefined&&currentBook.pages.length>=2
        &&soleEdit.pages.pages.length===currentBook.pages.length&&soleEdit.pages.active!==currentBook.active
        &&soleEdit.pages.pages.every((page,index)=>equal(page,currentBook.pages[index]))
        &&selected!==undefined&&selected.message.trim()!==''
        &&equal(selected.data,{})&&equal(selected.extra,{})
        &&(soleEdit.data===undefined||equal(soleEdit.data,{}))
        &&(soleEdit.extra===undefined||equal(soleEdit.extra,{}))){
        const strictBinding=await state.loadStoryBinding(sessionId,{strictRead:true,waitForAdoption:false})
        if(!strictBinding||strictBinding.cardId!==binding.cardId||strictBinding.storyId!==binding.storyId)throw new Error('消息编辑剧情绑定已改变')
        const swiped=await swipeGreetingLocked({ctx,state},source,strictBinding,soleEdit.pages.active,{
          verifySource:verify,
          expectedVariantCount:currentBook.pages.length,
          expectedGreetingText:selected.message,
          beforePublish:(current)=>{
            if(ctx.sessions.get(sessionId as Session['id'])!==source||source.seq!==sourceSeq||state.openFloors.has(sessionId))throw new Error('消息编辑期间会话已改变')
            beforeWrite?.(current)
          },
        })
        return {branch:{childSessionId:swiped.childSessionId,title:swiped.title}}
      }
    }
    const apply=(base:HelperState,targets:typeof history,deletions:Iterable<string>=deletedIdentities,rows:typeof metadata=metadata):HelperState=>{
      // 分支传入的是草稿 WAL 回滚后的状态；保留其 MVU 回执，不能重新复制来源剧情的已撤销楼层。
      const next={...base,scopes:{...base.scopes},extras:{...base.extras},swipes:{...base.swipes}}
      const identityBySeq=new Map(targets.map(target=>[target.seq,target.identity]))
      for(const identity of deletions){delete next.scopes[JSON.stringify(['message',identity])];delete next.extras[identity];delete next.swipes[identity]}
      for(const row of rows){
        const identity=identityBySeq.get(row.seq);if(!identity)throw new Error('编辑后消息身份不存在')
        if(row.data!==undefined)next.scopes[JSON.stringify(['message',identity])]=row.data
        if(row.extra!==undefined)next.extras[identity]=row.extra
        if(row.pages!==undefined)next.swipes[identity]=row.pages
      }
      helperTable(next.scopes);helperTable(next.extras);helperTable(next.swipes);return next
    }
    if(!changed.size&&!deleted.size){
      if(!metadata.length)return {branch:null}
      const next=apply(saved,history)
      await withHelperStoryWrite(ctx,state,sessionId,messageId,request.storyId,async(fs,begin)=>{
        if(equal(saved.scopes,next.scopes)&&equal(saved.extras,next.extras)&&equal(saved.swipes??{},next.swipes??{}))return
        serializeHelperState(next)
        await verify();await begin();await saveHelperState(fs,next)
      },beforeWrite,{waitForAdoption:false})
      return {branch:null,snapshot:await getHelperSnapshot(ctx,state,sessionId,messageId,{waitForAdoption:false})}
    }
    const first=Math.min(...changed.keys(),...deleted);let fromTurn=0
    for(const event of events){if(event.seq>first)break;if(event.type==='turn/start')fromTurn=event.data.turn;if(event.seq===first&&event.type==='assistant/message')fromTurn=event.data.turn}
    const seed=editedHistorySeed(events,changed,deleted)
    const nextHistory=helperHistoryOf(seed,{char:'',user:''}) // 发布前检查新历史与消息身份。
    const prepare=async(fs:import('../state/workspaceFs.js').WorkspaceFs,childId:string)=>{
      if(!metadata.length&&!deletedIdentities.size)return
      const wal=new Wal(join(fs.root,'state','wal'))
      // 分层落盘的最低楼层不得早于草稿中仍活跃的最高楼层，否则回滚旧层时后置修改会触发 WAL 依赖冲突。
      let retainedMaxTurn=0
      for(const item of await wal.listFloors()){
        if(item.rolledBack)continue
        const match=/#t([0-9]+)$/.exec(item.floor)
        const floorTurn=match?Number(match[1]):NaN
        if(Number.isSafeInteger(floorTurn)&&floorTurn>retainedMaxTurn)retainedMaxTurn=floorTurn
      }
      const byTurn=new Map<number,{deletions:string[];rows:typeof metadata}>()
      const bucket=(turn:number)=>{let entry=byTurn.get(turn);if(!entry){entry={deletions:[],rows:[]};byTurn.set(turn,entry)}return entry}
      for(const entry of deletedEntries)bucket(Math.max(turnBySeq.get(entry.seq)??0,retainedMaxTurn)).deletions.push(entry.identity)
      for(const row of metadata)bucket(Math.max(turnBySeq.get(row.seq)??0,retainedMaxTurn)).rows.push(row)
      let current=await loadHelperState(fs)
      for(const turn of [...byTurn.keys()].sort((a,b)=>a-b)){
        const entry=byTurn.get(turn)!
        const next=apply(current,nextHistory,entry.deletions,entry.rows)
        if(equal(current.scopes,next.scopes)&&equal(current.extras,next.extras)&&equal(current.swipes??{},next.swipes??{}))continue
        const floor=childId+'#t'+turn
        serializeHelperState(next)
        await wal.beginFloor(floor);await saveHelperState(new WorkspaceFs(fs.root,wal).withFloor(floor),next);await wal.commitFloor(floor)
        current=next
      }
    }
    return {branch:await forkEditedHistory({ctx,state},sessionId,binding.storyId!,seed,fromTurn,verify,prepare,deleted.size&&!changed.size?'删除聊天消息':'编辑聊天消息',()=>beforeWrite?.(binding))}
  }))
}
