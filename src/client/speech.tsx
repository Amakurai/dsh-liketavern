/**
 * 角色发言条：头像 + 名字 + 正文。正文经 output/render 正则后，
 * 再收起 UpdateVariable 等机读标签；整页 HTML 进沙箱 iframe，其余走 Markdown。
 *
 * 封面 iframe：允许 https 图片/字体；注入 ST getChatMessages/setChatMessage stub，
 * 卡内按钮经 postMessage 请求宿主 swipeGreeting。无 allow-same-origin。
 * 正则若只把标记换成 HTML，iframe 下面仍渲染剩余正文。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { IconCopyOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { buildCardSrcDoc, parseCardBridgeMessage } from '../core/cardFrame.js'
import {ScriptChoices,publishScriptChoices,clearScriptChoices,parseScriptChoices} from './helperChoices.js'
import {cardVariableLabels} from './cardVariableLabels.js'
import { stripDisplayMeta } from '../core/displaySanitize.js'
import { disableInteractiveParts, type TemplateDisplayPart } from '../core/templateDisplay.js'
import { isFullHtmlDocument } from '../core/htmlFragment.js'
import { cachedAvatar,invalidateSessionBinding } from './cache.js'
import {BINDING_CHANGED_EVENT} from './actions.js'
import { getTavernLocale, useT, useMarkdownLabels } from './i18n.js'
import { Avatar, Btn, Err, IconBtn, useLoader, useToast } from './util.js'
import type { TavernRemote } from './types.js'
import { CARD_VARIABLE_STYLES } from './styles.js'
import { helperJson, helperChanges, helperRecord, type HelperSnapshot } from '../core/helperRuntime.js'
import { watchHelperStory, notifyHelperStory } from './helperNotifications.js'
import type {HelperWorldbookContext,HelperWorldbookRequest,HelperWorldbookResult,HelperWorldbookRebindRequest} from '../core/helperWorldbook.js'
import { notifyHelperScripts } from './helperScriptNotifications.js'
import {parseHelperScriptTrees,type HelperScriptCommit,type HelperScriptContext,type HelperScriptView} from '../core/helperScripts.js'
import {parseHelperMessageEdits,type HelperMessageEditRequest,type HelperMessageEditResult} from '../core/helperChatEdits.js'
import {prepareHelperDisplay,registerHelperDisplay,waitHelperDisplay,HelperDisplayError,type HelperDisplayLease,type HelperDisplayRequest} from './helperDisplay.js'
import { emitHelperHostEvent,hasHelperEventAudience } from './helperEventRouter.js'
import { attachHelperEvents } from './helperEventRouter.js'
import type { RenderedOutput } from '../remote.js'

function displayFailure(error:unknown,t:ReturnType<typeof useT>):string{
  if(error instanceof HelperDisplayError)return t(error.code==='busy'?'speech.helperDisplayBusy':error.code==='timeout'?'speech.helperDisplayTimeout':'speech.helperDisplayStale')
  return error instanceof Error?error.message:String(error)
}
export function SpeechHtmlFrame(props: {
  onFrameReady?:()=>void
  onScriptError?:(message:string)=>void
  onScriptReady?:(ready:boolean)=>void
  registerDisplayGuard?:(guard:(request:HelperDisplayRequest)=>Promise<HelperDisplayLease>)=>()=>void
  srcDoc: string
  title: string
  widget: boolean
  compact?: boolean
  /** 重绘候选已真实挂载但尚未发布；允许只读查询和事件订阅，禁止产生剧情副作用。 */
  readOnly?: boolean
  /** 候选发布前尝试剧情写入时，立即废弃候选并保留旧卡。 */
  onReadOnlyViolation?:()=>void
  onMessageEdit?:(request:HelperMessageEditRequest)=>Promise<HelperMessageEditResult>
  onMessageBranch?:(branch:NonNullable<HelperMessageEditResult['branch']>)=>Promise<void>
  onSwipeGreeting?: (index: number) => void
  onHelperCommit?: (request:{storyId:string;historyRevision:string;changes:unknown})=>Promise<HelperSnapshot>
  onHelperRefresh?: ()=>Promise<HelperSnapshot>
  onScriptCommit?:(request:HelperScriptCommit)=>Promise<HelperScriptView>
  onScriptRefresh?:()=>Promise<HelperScriptContext>
  onWorldbookRequest?:(request:HelperWorldbookRequest)=>Promise<HelperWorldbookResult>
  onWorldbookRefresh?:()=>Promise<HelperWorldbookContext>
  onWorldbookBind?:(request:HelperWorldbookRebindRequest)=>Promise<HelperWorldbookContext>
  helperBinding?: {sessionId:string;storyId:string}
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [frameH, setFrameH] = useState<number | null>(null)
  const t = useT()
  const [editedBranch,setEditedBranch]=useState<HelperMessageEditResult['branch']>(null)
  const [branchError,setBranchError]=useState<string|null>(null)
  const srcDoc = props.srcDoc
  // 普通 React 重绘不销毁正在等待的回执；只有卡面文档替换或卸载才取消回复。
  const handlers = useRef({ readOnly:Boolean(props.readOnly),onReadOnlyViolation:props.onReadOnlyViolation,onFrameReady:props.onFrameReady,onScriptError:props.onScriptError,onScriptReady:props.onScriptReady,onMessageEdit:props.onMessageEdit,onMessageBranch:props.onMessageBranch,onSwipeGreeting: props.onSwipeGreeting, onHelperCommit: props.onHelperCommit, onHelperRefresh:props.onHelperRefresh,onScriptCommit:props.onScriptCommit,onScriptRefresh:props.onScriptRefresh,onWorldbookRequest:props.onWorldbookRequest,onWorldbookRefresh:props.onWorldbookRefresh,onWorldbookBind:props.onWorldbookBind, t })
  handlers.current = { readOnly:Boolean(props.readOnly),onReadOnlyViolation:props.onReadOnlyViolation,onFrameReady:props.onFrameReady,onScriptError:props.onScriptError,onScriptReady:props.onScriptReady,onMessageEdit:props.onMessageEdit,onMessageBranch:props.onMessageBranch,onSwipeGreeting: props.onSwipeGreeting, onHelperCommit: props.onHelperCommit, onHelperRefresh:props.onHelperRefresh,onScriptCommit:props.onScriptCommit,onScriptRefresh:props.onScriptRefresh,onWorldbookRequest:props.onWorldbookRequest,onWorldbookRefresh:props.onWorldbookRefresh,onWorldbookBind:props.onWorldbookBind, t }
  useEffect(() => {
    setFrameH(null)
  }, [srcDoc])

  useEffect(()=>{
    if(!props.helperBinding) return
    const {sessionId,storyId}=props.helperBinding
    return watchHelperStory(sessionId,storyId,()=>iframeRef.current?.contentWindow?.postMessage({
      source:'dsh-tavern-card',action:'helperSnapshotInvalidated',storyId,
    },'*'))
  },[props.helperBinding?.sessionId,props.helperBinding?.storyId])

  useLayoutEffect(() => {
    let active=true
    const eventEndpoint=props.helperBinding?attachHelperEvents(props.helperBinding.sessionId,props.helperBinding.storyId,
      message=>{if(active)iframeRef.current?.contentWindow?.postMessage(message,'*')}):undefined
    let editPending=false,editFinished=false,frameReady=false,legacyHeight=false
    const pending=new Set<string>(),scriptReceipts=new Set<string>(),editReceipts=new Map<string,NonNullable<HelperMessageEditResult['branch']>>()
    let displayBusy=false,guardSerial=0
    const heldGuards=new Set<string>(),guardEpoch=crypto.randomUUID()
    const displayReceipts=new Map<string,{lease:HelperDisplayLease;timer:ReturnType<typeof setTimeout>}>()
    const guards=new Map<string,{resolve:(lease:HelperDisplayLease)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
    const unlock=(id:string)=>iframeRef.current?.contentWindow?.postMessage({source:'dsh-tavern-card',action:'helperDisplayUnlock',requestId:id},'*')
    const unregisterGuard=props.registerDisplayGuard?.(request=>{
      if(pending.size||editPending||editFinished||guards.size) return Promise.reject(new Error(handlers.current.t('speech.helperSaveBusy')))
      const id='display-guard:'+guardEpoch+':'+(++guardSerial)
      return new Promise<HelperDisplayLease>((resolve,reject)=>{
        const timer=setTimeout(()=>{guards.delete(id);unlock(id);reject(new Error(handlers.current.t('speech.helperSaveBusy')))},5000)
        guards.set(id,{resolve,reject,timer});iframeRef.current?.contentWindow?.postMessage({source:'dsh-tavern-card',action:'helperDisplayGuard',requestId:id,storyId:request.storyId,historyRevision:request.historyRevision},'*')
      })
    })
    const choiceOwner=Symbol('script-choices')
    let choiceSerial=0
    const onMsg = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return
      const value:unknown=e.data
      if(helperRecord(value)&&['iframe-resize','resizeIframe'].includes(String(value.type))&&typeof value.height==='number'&&Number.isFinite(value.height)&&value.height>0){legacyHeight=true;setFrameH(Math.min(8000,Math.max(24,Math.ceil(value.height))));return}
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&value.action==='helperFrameReady'){
        if(!frameReady&&eventEndpoint?.matchesRuntime(value.runtimeId)){frameReady=true;handlers.current.onFrameReady?.()}return
      }
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&handlers.current.readOnly&&typeof value.action==='string'){
        // 候选沙箱必须能完成 connect/subscribe/ready 和只读上下文查询，但在发布前
        // 不能把变量、消息、世界书、脚本或二次重绘写进真实剧情；候选超时丢弃时不能留副作用。
        const responses:Record<string,string>={helperDisplayRefresh:'helperDisplayResult',helperMessageEdit:'helperMessageEditResult',
          helperVariablesCommit:'helperVariablesResult',helperScriptLibraryCommit:'helperScriptLibraryResult',
          helperWorldbookOperation:'helperWorldbookResult',helperWorldbookBind:'helperWorldbookBindResult',helperEventEmit:'helperEventResult'}
        const resultAction=responses[value.action]
        if(resultAction){
          // 候选卡初始化会用 helperEventEmit 报告 iframe render started/ended。它尚未发布，
          // 不能把事件泄露给当前卡面，但也不能返回失败（否则发布后的卡会永久留下错误面板）。
          // 原样回传 args，使兼容事件调用像一次成功的无副作用发送。
          const stagedEvent=value.action==='helperEventEmit'
          iframeRef.current.contentWindow?.postMessage({source:'dsh-tavern-card',action:resultAction,requestId:value.requestId,
            ...(stagedEvent?{runtimeId:value.runtimeId,args:value.args}:{storyId:value.storyId}),ok:stagedEvent,
            ...(stagedEvent?{}:{error:handlers.current.t('speech.helperDisplayBusy')})},'*')
          if(!stagedEvent)handlers.current.onReadOnlyViolation?.()
          return
        }
        if(value.action==='swipeGreeting'){handlers.current.onReadOnlyViolation?.();return}
        if(['helperScriptChoices','helperScriptDiagnostic','helperScriptReady','helperMessageEditApplied','helperScriptLibraryApplied'].includes(value.action))return
      }
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&value.action==='helperDisplayGuardResult'&&typeof value.requestId==='string'){
        const id=value.requestId,guard=guards.get(id);if(!guard)return
        guards.delete(id);clearTimeout(guard.timer)
        if(value.ok!==true||pending.size||editPending){unlock(id);guard.reject(new Error(typeof value.error==='string'?value.error:handlers.current.t('speech.helperSaveBusy')));return}
        heldGuards.add(id)
        eventEndpoint?.setHostEventsEnabled(false)
        // 锁从准备重绘时取得，随后还要覆盖最多 25s 服务端重渲染和 60s 隐藏投影发布。
        // 留 5s 调度余量；失败路径仍会主动 cancel，不依赖此兜底过期。
        let held=true;const expires=Date.now()+90000;const check=()=>{if(!active||!held||Date.now()>expires)throw new Error(handlers.current.t('speech.helperStoryChanged'))}
        guard.resolve({check,commit:check,cancel:()=>{if(held){held=false;heldGuards.delete(id);if(!heldGuards.size)eventEndpoint?.setHostEventsEnabled(true);unlock(id)}}});return
      }
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&value.action==='helperDisplayApplied'&&typeof value.requestId==='string'){
        const receipt=displayReceipts.get(value.requestId);if(!receipt)return
        displayReceipts.delete(value.requestId);clearTimeout(receipt.timer)
        try{receipt.lease.commit()}catch(error){setBranchError(displayFailure(error,handlers.current.t))}finally{receipt.lease.cancel();displayBusy=false}return
      }
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&value.action==='helperDisplayRefresh'&&typeof value.requestId==='string'&&value.requestId.length<=96){
        const target=iframeRef.current.contentWindow,requestId=value.requestId
        const respond=(data:Record<string,unknown>)=>{if(active&&iframeRef.current?.contentWindow===target)target?.postMessage({source:'dsh-tavern-card',action:'helperDisplayResult',requestId,...data},'*')}
        if(displayBusy||pending.size||editPending||editFinished){respond({ok:false,error:handlers.current.t('speech.helperSaveBusy')});return}
        displayBusy=true
        void(async()=>{
          const binding=props.helperBinding
          if(!binding||value.storyId!==binding.storyId||typeof value.historyRevision!=='string'||value.historyRevision.length>96||value.ids!==null&&(!Array.isArray(value.ids)||value.ids.length>4096||value.ids.some(id=>typeof id!=='number'||!Number.isSafeInteger(id)||id<0||id>=4096)))throw new Error(handlers.current.t('speech.helperUnsupported'))
          const snapshot=await waitHelperDisplay(Promise.resolve(handlers.current.onHelperRefresh?.()),AbortSignal.timeout(5000))
          if(!snapshot||snapshot.storyId!==value.storyId||snapshot.historyRevision!==value.historyRevision||Array.isArray(value.ids)&&value.ids.some(id=>Number(id)>=snapshot.messages.length))throw new Error(handlers.current.t('speech.helperStoryChanged'))
          const lease=await prepareHelperDisplay(binding.sessionId,{storyId:binding.storyId,historyRevision:value.historyRevision,ids:value.ids as number[]|null})
          if(!active){lease.cancel();return}
          const timer=setTimeout(()=>{displayReceipts.delete(requestId);lease.cancel();displayBusy=false},10000)
          displayReceipts.set(requestId,{lease,timer});respond({ok:true})
        })().catch(error=>{displayBusy=false;respond({ok:false,error:displayFailure(error,handlers.current.t)})})
        return
      }
      if(heldGuards.size&&helperRecord(value)&&value.source==='dsh-tavern-card'&&typeof value.action==='string'){
        const responses:Record<string,string>={helperMessageEdit:'helperMessageEditResult',helperVariablesCommit:'helperVariablesResult',helperSnapshotGet:'helperSnapshotResult',helperScriptLibraryCommit:'helperScriptLibraryResult',helperScriptLibrariesGet:'helperScriptLibrariesResult',helperWorldbookOperation:'helperWorldbookResult',helperWorldbookContextGet:'helperWorldbookContextResult',helperWorldbookBind:'helperWorldbookBindResult'}
        const action=responses[value.action]
        if(action){iframeRef.current.contentWindow?.postMessage({source:'dsh-tavern-card',action,requestId:value.requestId,ok:false,error:handlers.current.t('speech.helperSaveBusy')},'*');return}
        if(value.action==='swipeGreeting')return
      }
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&value.action==='helperMessageEditApplied'&&typeof value.requestId==='string'){
        const branch=editReceipts.get(value.requestId);if(branch){editReceipts.delete(value.requestId);void handlers.current.onMessageBranch?.(branch).catch(error=>{if(active)setBranchError(String(error))})}return
      }
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&value.action==='helperMessageEdit'&&typeof value.requestId==='string'&&value.requestId.length<=96){
        const target=iframeRef.current.contentWindow,requestId=value.requestId
        const respond=(result:Record<string,unknown>)=>{if(active&&iframeRef.current?.contentWindow===target)target?.postMessage({source:'dsh-tavern-card',action:'helperMessageEditResult',requestId,...result},'*')}
        if(pending.has(requestId))return
        if(pending.size>=4||editPending||editFinished||editReceipts.size){respond({ok:false,error:handlers.current.t('speech.helperSaveBusy')});return}
        pending.add(requestId);editPending=true
        void(async()=>{
          if(!handlers.current.onMessageEdit||!handlers.current.onMessageBranch||typeof value.storyId!=='string'||value.storyId!==props.helperBinding?.storyId||typeof value.historyRevision!=='string'||value.historyRevision.length>96)throw new Error(handlers.current.t('speech.helperUnsupported'))
          const result=await handlers.current.onMessageEdit({storyId:value.storyId,historyRevision:value.historyRevision,edits:parseHelperMessageEdits(value.edits),...(value.before===undefined?{}:{before:parseHelperMessageEdits(value.before)})})
          if(active&&result.branch){editFinished=true;editReceipts.set(requestId,result.branch);setEditedBranch(result.branch);setBranchError(null)}
          respond({ok:true,result})
        })().catch(error=>respond({ok:false,error:error instanceof Error?error.message:String(error)})).finally(()=>{editPending=false;pending.delete(requestId)})
        return
      }
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&value.action==='helperScriptChoices'&&props.onScriptReady&&props.helperBinding&&eventEndpoint?.matchesRuntime(value.runtimeId)){
        const serial=++choiceSerial,binding=props.helperBinding
        void (async()=>{try{if(typeof value.messageId!=='number')throw new Error('选项目标消息无效');const choices=parseScriptChoices(value.choices),context=await handlers.current.onHelperRefresh?.();if(!active||serial!==choiceSerial)return;if(!context||context.storyId!==binding.storyId||context.storyId!==value.storyId||context.historyRevision!==value.historyRevision)throw new Error(handlers.current.t('speech.helperStoryChanged'));publishScriptChoices(choiceOwner,binding.sessionId,context,value.messageId,choices)}catch(error){if(active&&serial===choiceSerial){clearScriptChoices(choiceOwner);handlers.current.onScriptError?.(error instanceof Error?error.message:String(error))}}})();return
      }
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&value.action==='helperScriptDiagnostic' &&eventEndpoint?.matchesRuntime(value.runtimeId)&&typeof value.error==='string'&&value.error.length>0&&value.error.length<=2000){choiceSerial++;clearScriptChoices(choiceOwner);handlers.current.onScriptError?.(value.error);handlers.current.onScriptReady?.(false);return}
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&value.action==='helperScriptReady'&&eventEndpoint?.matchesRuntime(value.runtimeId)){handlers.current.onScriptReady?.(value.ok===true);return}
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&typeof value.action==='string'&&value.action.startsWith('helperEvent')) {
        (value.action==='helperEventConnect'||value.action==='helperEventDisconnect')&&handlers.current.onScriptReady?.(false)
        eventEndpoint?.receive(value);return
      }
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&value.action==='helperScriptLibraryApplied'&&typeof value.requestId==='string') {
        if(scriptReceipts.has(value.requestId)&&props.helperBinding){scriptReceipts.clear();notifyHelperScripts(props.helperBinding.sessionId,props.helperBinding.storyId)}
        return
      }
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&(value.action==='helperScriptLibraryCommit'||value.action==='helperScriptLibrariesGet')&&typeof value.requestId==='string'&&value.requestId.length<=96) {
        const target=iframeRef.current.contentWindow,requestId=value.requestId,resultAction=value.action==='helperScriptLibraryCommit'?'helperScriptLibraryResult':'helperScriptLibrariesResult'
        const respond=(result:Record<string,unknown>)=>{if(active&&iframeRef.current?.contentWindow===target)target?.postMessage({source:'dsh-tavern-card',action:resultAction,requestId,...result},'*')}
        if(pending.has(requestId))return
        if(pending.size>=4){respond({ok:false,error:handlers.current.t('speech.helperSaveBusy')});return}
        pending.add(requestId)
        void(async()=>{
          if(typeof value.storyId!=='string'||value.storyId!==props.helperBinding?.storyId)throw new Error(handlers.current.t('speech.helperStoryChanged'))
          if(value.action==='helperScriptLibrariesGet'){
            if(!handlers.current.onScriptRefresh)throw new Error(handlers.current.t('speech.helperUnsupported'))
            const context=await handlers.current.onScriptRefresh()
            if(context.storyId!==value.storyId)throw new Error(handlers.current.t('speech.helperStoryChanged'))
            respond({ok:true,context});return
          }
          if(!handlers.current.onScriptCommit||typeof value.bindingRevision!=='string'||value.bindingRevision.length>96||typeof value.revision!=='string'||value.revision.length>96||!['global','preset','character'].includes(String(value.type)))throw new Error(handlers.current.t('speech.helperUnsupported'))
          const library=await handlers.current.onScriptCommit({storyId:value.storyId,bindingRevision:value.bindingRevision,type:value.type as HelperScriptCommit['type'],revision:value.revision,trees:parseHelperScriptTrees(value.trees)})
          if(active){scriptReceipts.add(requestId);if(scriptReceipts.size>16)scriptReceipts.delete(scriptReceipts.values().next().value!)}
          respond({ok:true,library})
        })().catch(error=>respond({ok:false,error:error instanceof Error?error.message:String(error)})).finally(()=>pending.delete(requestId))
        return
      }
      if(helperRecord(value)&&value.source==='dsh-tavern-card'&&(value.action==='helperWorldbookOperation'||value.action==='helperWorldbookContextGet'||value.action==='helperWorldbookBind')&&typeof value.requestId==='string'&&value.requestId.length<=96){
        const target=iframeRef.current.contentWindow,requestId=value.requestId,resultAction=value.action==='helperWorldbookOperation'?'helperWorldbookResult':value.action==='helperWorldbookBind'?'helperWorldbookBindResult':'helperWorldbookContextResult'
        const respond=(result:Record<string,unknown>)=>{if(active&&iframeRef.current?.contentWindow===target)target?.postMessage({source:'dsh-tavern-card',action:resultAction,requestId,...result},'*')}
        if(pending.has(requestId))return
        if(pending.size>=4){respond({ok:false,error:handlers.current.t('speech.helperSaveBusy')});return}
        pending.add(requestId)
        void(async()=>{
          if(typeof value.storyId!=='string'||value.storyId!==props.helperBinding?.storyId)throw new Error(handlers.current.t('speech.helperStoryChanged'))
          if(value.action==='helperWorldbookBind'){
            if(!handlers.current.onWorldbookBind||typeof value.bindingRevision!=='string'||value.bindingRevision.length>96||!['global','character','chat','ensure-chat','settings'].includes(String(value.kind)))throw new Error(handlers.current.t('speech.helperUnsupported'))
            const context=await handlers.current.onWorldbookBind({storyId:value.storyId,bindingRevision:value.bindingRevision,kind:value.kind as HelperWorldbookRebindRequest['kind'],selection:helperJson(value.selection,16384)})
            if(context.storyId!==value.storyId)throw new Error(handlers.current.t('speech.helperStoryChanged'))
            respond({ok:true,context});return
          }
          if(value.action==='helperWorldbookContextGet'){
            if(!handlers.current.onWorldbookRefresh)throw new Error(handlers.current.t('speech.helperUnsupported'))
            const context=await handlers.current.onWorldbookRefresh();if(context.storyId!==value.storyId)throw new Error(handlers.current.t('speech.helperStoryChanged'));respond({ok:true,context});return
          }
          if(!handlers.current.onWorldbookRequest||typeof value.bindingRevision!=='string'||value.bindingRevision.length>96||typeof value.name!=='string'||value.name.length>256||!['get','replace','create','upsert','delete'].includes(String(value.operation))||value.revision!==undefined&&(typeof value.revision!=='string'||value.revision.length>96))throw new Error(handlers.current.t('speech.helperUnsupported'))
          const result=await handlers.current.onWorldbookRequest({storyId:value.storyId,bindingRevision:value.bindingRevision,name:value.name,operation:value.operation as HelperWorldbookRequest['operation'],...(value.revision===undefined?{}:{revision:value.revision as string}),...(value.entries===undefined?{}:{entries:helperJson(value.entries,8*1024*1024)}),...(value.label===undefined?{}:{label:value.label as string})})
          respond({ok:true,result})
        })().catch(error=>respond({ok:false,error:error instanceof Error?error.message:String(error)})).finally(()=>pending.delete(requestId))
        return
      }
      if(helperRecord(value) && value.source==='dsh-tavern-card' && (value.action==='helperVariablesCommit'||value.action==='helperSnapshotGet')
        && typeof value.requestId==='string' && value.requestId.length<=96) {
        const target=iframeRef.current.contentWindow, requestId=value.requestId
        const resultAction=value.action==='helperSnapshotGet'?'helperSnapshotResult':'helperVariablesResult'
        const respond=(result:Record<string,unknown>)=>{
          if(active && iframeRef.current?.contentWindow===target) target?.postMessage({source:'dsh-tavern-card',action:resultAction,requestId,...result},'*')
        }
        if(pending.has(requestId)) return
        if(pending.size>=4) {respond({ok:false,error:handlers.current.t('speech.helperSaveBusy')});return}
        pending.add(requestId)
        void (async()=>{
          if(value.action==='helperSnapshotGet') {
            const refresh=handlers.current.onHelperRefresh
            if(!refresh||typeof value.storyId!=='string') throw new Error(handlers.current.t('speech.helperUnsupported'))
            const snapshot=await refresh()
            if(snapshot.storyId!==value.storyId) throw new Error(handlers.current.t('speech.helperStoryChanged'))
            respond({ok:true,snapshot});return
          }
          const commit=handlers.current.onHelperCommit
          if(!commit||typeof value.storyId!=='string'||typeof value.historyRevision!=='string') throw new Error(handlers.current.t('speech.helperUnsupported'))
          const snapshot=await commit({storyId:value.storyId,historyRevision:value.historyRevision,changes:helperChanges(value.changes)})
          respond({ok:true,scopes:snapshot.scopes})
        })().catch(error=>respond({ok:false,error:error instanceof Error?error.message:String(error)})).finally(()=>pending.delete(requestId))
        return
      }
      const parsed = parseCardBridgeMessage(e.data)
      if (!parsed) return
      if (parsed.action === 'swipeGreeting' && typeof parsed.index === 'number') {
        handlers.current.onSwipeGreeting?.(parsed.index)
      }
      if (!legacyHeight && parsed.action === 'resize' && typeof parsed.height === 'number' && Number.isFinite(parsed.height)) {
        setFrameH(Math.min(8000, Math.max(24, Math.ceil(parsed.height))))
      }
    }
    window.addEventListener('message', onMsg)
    return () => {active=false;clearScriptChoices(choiceOwner);unregisterGuard?.();for(const [id,guard] of guards){clearTimeout(guard.timer);unlock(id);guard.reject(new Error('卡面已关闭'))}for(const receipt of displayReceipts.values()){clearTimeout(receipt.timer);receipt.lease.cancel()}eventEndpoint?.dispose();window.removeEventListener('message', onMsg)}
  }, [srcDoc,props.helperBinding?.sessionId,props.helperBinding?.storyId])

  const frameStyle =
    frameH != null
      ? { height: frameH, minHeight: 0, overflow: 'hidden' as const }
      : props.compact
        ? { height: 48, minHeight: 0, overflow: 'auto' as const }
      : props.widget
        ? { height: 280, minHeight: 0, overflow: 'auto' as const }
        : { overflow: 'auto' as const }

  return (
    <>
    <iframe
      ref={iframeRef}
      className={`dsh-tavern-speechHtml${props.widget || props.compact ? ' is-widget' : ''}`}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title={props.title}
      style={frameStyle}
    />
    {editedBranch&&<div className="dsh-tavern-cardBackupBar"><Btn onClick={()=>{void props.onMessageBranch?.(editedBranch).catch(error=>setBranchError(String(error)))}}>{t('speech.openEditedBranch')}</Btn><Err message={branchError}/></div>}
    </>
  )
}

interface SpeechBubbleProps {
  remote: TavernRemote
  sessionId: string
  cardId: string
  /** 角色资产保存后的修订信号；变更时重取头像与卡面宏/开场白，不作为沙箱身份。 */
  characterRevision?: string
  /** 同一卡片的剧情、人设、预设或世界书绑定变化；需重新执行 output/render。 */
  bindingRevision?: string
  name: string
  rawText: string
  /** 宿主按当前 turn-tail 核验出的文件链接解析器；不可由卡面或文本自行构造。 */
  fileMentions?: ComponentProps<typeof MarkdownText>['fileMentions']
  /** 必须由宿主 owner 渲染的消息图片，放在正文列内以与卡片内容对齐。 */
  media?: ReactNode
  messageId?: number
  streaming?: boolean
  /** 会话级交互卡开关（binding.interactiveCards）；null/缺省回落全局设置。 */
  interactiveCards?: boolean | null
  onMessageBranch?:(branch:NonNullable<HelperMessageEditResult['branch']>)=>Promise<void>
  onSwipeGreeting?: (index: number) => void | Promise<void>
}

/** 按会话和角色卸载旧气泡状态，慢请求的报错不能留到新会话。 */
export function SpeechBubble(props: SpeechBubbleProps) {
  return <SpeechBubbleSession key={`${props.sessionId}:${props.cardId}`} {...props} />
}

interface DisplayProjectionProps extends SpeechBubbleProps {
  value: RenderedOutput
  staging: boolean
  refreshing?: boolean
  publishing?: boolean
  registerDisplayGuard: (guard: (request: HelperDisplayRequest) => Promise<HelperDisplayLease>) => () => void
  isCurrent: () => boolean
  onComplete: () => void
  onFailure: (error: unknown) => void
  onPublished?: () => void
  onSwipe: (index: number) => void
}

/**
 * 一份可独立存活的卡面投影。重绘时新投影先以 hidden 真挂载，完成 iframe ready
 * 与宿主显示事件后只切换容器可见性；key 不变，已启动的沙箱不会为发布再执行一次。
 */
function DisplayProjection(props: DisplayProjectionProps) {
  const { remote, sessionId, rawText, streaming, value } = props
  const t = useT(), markdownLabels = useMarkdownLabels()
  const locale = getTavernLocale()
  const interactive = props.interactiveCards ?? value.interactiveCards
  const visibleParts = useMemo(():TemplateDisplayPart[] => {
    const htmls = !streaming && interactive
      ? value.htmls?.length ? value.htmls : value.html ? [value.html] : []
      : []
    const text = !streaming
      ? interactive || value.text || value.parts !== undefined ? value.text : stripDisplayMeta(rawText)
      : stripDisplayMeta(rawText)
    const storedParts = !streaming ? value.parts : undefined
    const parts:TemplateDisplayPart[] = storedParts
      ? interactive ? [...storedParts] : disableInteractiveParts(storedParts)
      : [...htmls.map(html => ({ kind: 'html' as const, text: html })), ...(text ? [{ kind: 'markdown' as const, text }] : [])]
    if (!parts.length) parts.push({ kind: 'markdown', text: text || ' ' })
    return parts
  },[streaming,interactive,value,rawText])

  // 每个卡面会内嵌完整消息快照。普通气泡重绘只更新事件回调，不重复序列化历史。
  const frameDocs=useMemo(()=>{
    let frameIndex=0
    return visibleParts.map(part=>{
      if(part.kind!=='html')return null
      return buildCardSrcDoc(part.text, {
        greetings: value.greetings ?? [], greetingIndex: value.greetingIndex ?? 0, connectHosts: value.whitelist,
        helperSnapshot: value.helper, scriptLibraries: value.helperScripts, worldbooks: value.helperWorldbooks,
        scriptLibraryLabels: { saving: t('speech.scriptSaving'), saved: t('speech.scriptSaved'), failed: t('speech.scriptSaveFailed') },
        persistenceLabels: { saving: t('speech.helperSaving'), saved: t('speech.helperSaved'), failed: t('speech.helperSaveFailed'), refresh: t('speech.helperRefresh') },
        helperContext: { message: rawText, messageId: value.canSwipeGreeting !== false ? 0 : props.messageId ?? 0, name: props.name,
          macroName: value.characterName ?? props.name, userName: value.userName, frameIndex: frameIndex++,
          canSwipe: value.canSwipeGreeting !== false && Boolean(props.onSwipeGreeting) },
        helperLabels: { diagnostics: t('speech.helperMessages'), unsupported: t('speech.helperUnsupported') },
        variableStyles: CARD_VARIABLE_STYLES,
        variableLabels: cardVariableLabels(t, value.helper ? t('speech.helperDataNote') : t('speech.cardDataNote')),
      })
    })
  },[visibleParts,value,rawText,props.messageId,props.name,Boolean(props.onSwipeGreeting),locale])

  const htmlCount = visibleParts.filter(part => part.kind === 'html').length
  const cycleRef = useRef({ seen: new Set<number>(), done: false, active: true })
  const latest = useRef({ isCurrent: props.isCurrent, onComplete: props.onComplete, onFailure: props.onFailure })
  latest.current = { isCurrent: props.isCurrent, onComplete: props.onComplete, onFailure: props.onFailure }
  const completeDisplay = () => {
    const cycle = cycleRef.current
    if (!cycle.active || cycle.done || cycle.seen.size < htmlCount || streaming) return
    cycle.done = true
    const current = () => cycle.active && latest.current.isCurrent()
    void (async () => {
      if (props.messageId === undefined || !hasHelperEventAudience(sessionId)) return
      if (!current()) throw new HelperDisplayError('stale')
      let context = value.helperContext
      if (value.helper) {
        const message = value.helper.messages[value.helper.currentMessageId]
        if (!message || message.role === 'system') throw new HelperDisplayError('stale')
        context = { storyId:value.helper.storyId,historyRevision:value.helper.historyRevision,
          currentMessageId:value.helper.currentMessageId,currentMessageRole:message.role }
      } else if (!context) {
        // 兼容仍返回旧 RenderedOutput 形状的同代宿主；新服务纯文本走紧凑上下文，
        // HTML 则始终携带完整 helper 快照。
        const response = await waitHelperDisplay(remote.getHelperSnapshot({ sessionId, messageId: props.messageId }), AbortSignal.timeout(5000))
        if (!response.ok) throw new Error(response.error.message)
        const message = response.value.messages[response.value.currentMessageId]
        if (!message || message.role === 'system') throw new HelperDisplayError('stale')
        context = { storyId:response.value.storyId,historyRevision:response.value.historyRevision,
          currentMessageId:response.value.currentMessageId,currentMessageRole:message.role }
      }
      if (!context || !current()) throw new HelperDisplayError('stale')
      await emitHelperHostEvent(sessionId, context.storyId,
        context.currentMessageRole === 'user' ? 'user_message_rendered' : 'character_message_rendered',
        context.currentMessageRole === 'user' ? [context.currentMessageId] : [context.currentMessageId, 'normal'], current)
    })().then(() => {
      if (current()) latest.current.onComplete()
    }).catch(error => {
      if (current()) latest.current.onFailure(error)
    })
  }
  useEffect(() => { if (!htmlCount) completeDisplay() }, [htmlCount, streaming])
  useEffect(() => () => { cycleRef.current.active = false }, [])
  // publishing 首帧已经把旧投影移除并显示了本容器；layout effect 后才能通知 all
  // 聚合继续发送 CHAT_CHANGED，避免事件先于真实 DOM 发布。
  useLayoutEffect(() => { if (props.publishing) props.onPublished?.() }, [props.publishing, props.onPublished])

  const content = visibleParts.map((part, index) => {
    if (part.kind === 'markdown') return <MarkdownText key={`text:${index}`} text={part.text} streaming={Boolean(streaming)} labels={markdownLabels} fileMentions={props.fileMentions} />
    const srcDoc = frameDocs[index]!
    const fullDocumentCover = isFullHtmlDocument(part.text)
    const widget = !fullDocumentCover && visibleParts.length > 1
    const frame = <SpeechHtmlFrame
      key={`${index}:${part.text.length}`}
      onFrameReady={() => { const cycle = cycleRef.current; cycle.seen.add(index); completeDisplay() }}
      registerDisplayGuard={props.registerDisplayGuard}
      srcDoc={srcDoc}
      title={part.title || props.name}
      widget={widget}
      compact={Boolean(!streaming&&value.parts) && !fullDocumentCover}
      readOnly={props.staging||props.refreshing}
      onReadOnlyViolation={props.staging?()=>props.onFailure(new HelperDisplayError('stale')):undefined}
      helperBinding={value.helper ? { sessionId, storyId: value.helper.storyId } : undefined}
      onSwipeGreeting={props.onSwipe}
      onMessageBranch={props.onMessageBranch}
      onMessageEdit={props.messageId === undefined ? undefined : async request => {
        const result = await remote.editHelperMessages({ ...request, sessionId, messageId: props.messageId! })
        if (!result.ok) throw new Error(result.error.message)
        if (result.value.snapshot) notifyHelperStory(sessionId, result.value.snapshot.storyId)
        return result.value
      }}
      onWorldbookBind={props.messageId === undefined ? undefined : async request => {
        const result = await remote.rebindHelperWorldbooks({ ...request, sessionId, messageId: props.messageId! })
        if (!result.ok) throw new Error(result.error.message)
        invalidateSessionBinding(sessionId);window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
        return result.value
      }}
      onWorldbookRequest={props.messageId === undefined ? undefined : async request => {
        const result = await remote.helperWorldbookOperation({ ...request, sessionId, messageId: props.messageId! })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }}
      onWorldbookRefresh={props.messageId === undefined ? undefined : async () => {
        if (!value.helper) throw new Error(t('speech.helperUnsupported'))
        const result = await remote.getHelperWorldbookContext({ sessionId, storyId: value.helper.storyId })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }}
      onScriptCommit={props.messageId === undefined ? undefined : async request => {
        const result = await remote.commitSessionHelperScripts({ ...request, sessionId })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }}
      onScriptRefresh={props.messageId === undefined ? undefined : async () => {
        if (!value.helper) throw new Error(t('speech.helperUnsupported'))
        const result = await remote.getSessionHelperScripts({ sessionId, storyId: value.helper.storyId })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }}
      onHelperCommit={props.messageId === undefined ? undefined : async request => {
        const result = await remote.commitHelperVariables({ ...request, sessionId, messageId: props.messageId! })
        if (!result.ok) throw new Error(result.error.message)
        notifyHelperStory(sessionId, result.value.storyId)
        return result.value
      }}
      onHelperRefresh={props.messageId === undefined ? undefined : async () => {
        const result = await remote.getHelperSnapshot({ sessionId, messageId: props.messageId! })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }}
    />
    return part.title
      ? <details key={`fold:${index}`} className="dsh-tavern-reason"><summary>{part.title}</summary>{frame}</details>
      : frame
  })

  return <div className={`dsh-tavern-displayProjection${props.staging?' is-staging':''}`} aria-hidden={props.staging || undefined}>{content}</div>
}

interface DisplayStage {
  id: number
  base: object
  value: RenderedOutput
  phase: 'preparing' | 'publishing'
  after: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  settled: boolean
  ready(): void
  published(): void
  abort(error: unknown, report?: boolean): void
}

function SpeechBubbleSession(props: SpeechBubbleProps) {
  const { remote, sessionId, cardId, name, rawText, streaming, onSwipeGreeting } = props
  const t = useT()
  const markdownLabels = useMarkdownLabels()
  // 头像走进程内缓存（key=cardId，TTL 60s）：同一会话的 N 条气泡不再各传一次 dataURL。
  const avatar = useLoader(() => cachedAvatar(remote, cardId), [cardId], Boolean(cardId))
  const loaded = useLoader(
    () => remote.renderOutputText({ sessionId, text: rawText, messageId: props.messageId }),
    [sessionId, rawText, props.messageId, props.interactiveCards,props.bindingRevision],
    Boolean(rawText) && !streaming,
  )
  const knownCharacterRevision=useRef<string|undefined>(undefined)
  useEffect(()=>{
    const revision=props.characterRevision
    if(revision===undefined)return
    // 详情通常晚于气泡首屏返回；undefined→首个 revision 只是建立基线，服务端首屏
    // 已读取当前角色，不能让长历史的每条消息因此再做一次完整 output/render。
    if(knownCharacterRevision.current===undefined){knownCharacterRevision.current=revision;return}
    if(knownCharacterRevision.current===revision)return
    knownCharacterRevision.current=revision;avatar.reload();loaded.reload()
  },[props.characterRevision,avatar.reload,loaded.reload])
  const [display, setDisplay] = useState<{ base: object; value: RenderedOutput; id: number } | null>(null)
  const [stage, setStage] = useState<DisplayStage | null>(null)
  const stageRef = useRef<DisplayStage | null>(null)
  const projectionSerial = useRef(0)
  // 资产/绑定刷新期间沿用上一份已成功发布的投影，避免短暂显示原始 HTML 源码。
  // 正文或消息身份改变时立即失效；会话与角色身份由 SpeechBubble 的 key 隔离。
  const projectionIdentity=useMemo(()=>({}),[sessionId,rawText,props.messageId,props.interactiveCards,streaming])
  const lastReady=useRef<{identity:object;source:object;state:{status:'ready';value:RenderedOutput};id:number}|null>(null)
  if(loaded.state.status==='ready'&&(lastReady.current?.source!==loaded.state||lastReady.current.identity!==projectionIdentity)) {
    lastReady.current={identity:projectionIdentity,source:loaded.state,state:loaded.state,id:++projectionSerial.current}
  }
  const remembered=lastReady.current?.identity===projectionIdentity?lastReady.current:null
  const baseProjectionId=remembered?.id??0
  const visibleState=loaded.state.status==='ready'?loaded.state:remembered?.state??loaded.state
  const validDisplay = display?.base === (loaded.state.status==='ready'?loaded.state:remembered?.source) ? display : null
  const validStage = stage?.base === loaded.state ? stage : null
  const activeOverride = validStage?.phase === 'publishing' ? validStage : validDisplay
  const rendered = { state: useMemo(() => activeOverride
    ? { status: 'ready' as const, value: activeOverride.value }
    : visibleState, [activeOverride, visibleState]) }
  const displayGuards=useRef(new Set<(request:HelperDisplayRequest)=>Promise<HelperDisplayLease>>())
  const renderLatest=useRef(rendered.state);renderLatest.current=rendered.state
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  useEffect(()=>setLifecycleError(null),[loaded.state])
  useEffect(()=>{
    if(props.messageId===undefined||streaming)return
    let alive=true
    const stop=registerHelperDisplay(sessionId,async(request,signal)=>{
      if(stageRef.current)throw new HelperDisplayError('busy')
      const current=renderLatest.current
      if(current.status!=='ready')throw new HelperDisplayError('stale')
      // 旧气泡的显示快照可以落后于新消息；仅冻结剧情归属，目标下标和修订必须以当前宿主快照为准。
      const currentContext=current.value.helper??current.value.helperContext
      if(currentContext&&currentContext.storyId!==request.storyId)throw new HelperDisplayError('stale')
      const response=await waitHelperDisplay(remote.getHelperSnapshot({sessionId,messageId:props.messageId!}),signal)
      if(!response.ok)throw new Error(response.error.message)
      const snapshot=response.value
      if(snapshot.storyId!==request.storyId||snapshot.historyRevision!==request.historyRevision)throw new HelperDisplayError('stale')
      if(request.ids!==null&&!request.ids.includes(snapshot.currentMessageId))return null
      const leases:HelperDisplayLease[]=[]
      try{
        const results=await Promise.allSettled([...displayGuards.current].map(guard=>guard(request)))
        for(const result of results)if(result.status==='fulfilled')leases.push(result.value)
        const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason
        const next=await waitHelperDisplay(remote.renderOutputText({sessionId,text:rawText,messageId:props.messageId}),signal)
        if(!next.ok)throw new Error(next.error.message)
        const nextContext=next.value.helper??next.value.helperContext
        const verified=nextContext?{ok:true as const,value:nextContext}:await waitHelperDisplay(remote.getHelperSnapshot({sessionId,messageId:props.messageId!}),signal)
        if(!verified.ok||verified.value.storyId!==request.storyId||verified.value.historyRevision!==request.historyRevision)throw new HelperDisplayError('stale')
        const check=()=>{if(!alive||renderLatest.current!==current)throw new HelperDisplayError('stale');for(const lease of leases)lease.check()}
        check()
        let resolve!:()=>void,reject!:(error:unknown)=>void,committed=false,record!:DisplayStage
        const after=new Promise<void>((yes,no)=>{resolve=yes;reject=no});void after.catch(()=>{})
        const release=()=>{for(const lease of leases)lease.cancel()}
        const abort=(error:unknown,report=committed)=>{
          if(record.settled)return
          record.settled=true;clearTimeout(record.timer);release()
          if(stageRef.current===record){stageRef.current=null;if(alive)setStage(previous=>previous?.id===record.id?null:previous)}
          reject(error)
          if(report&&alive)setLifecycleError(displayFailure(error,t))
        }
        record={id:++projectionSerial.current,base:loaded.state,value:next.value,phase:'preparing',after,settled:false,
          abort,
          ready:()=>{
            if(record.settled||stageRef.current!==record||record.phase!=='preparing')return
            try{check();record.phase='publishing';if(alive)setStage({...record})}catch(error){abort(error,true)}
          },
          published:()=>{
            if(record.settled||stageRef.current!==record||record.phase!=='publishing')return
            record.settled=true;clearTimeout(record.timer)
            setDisplay({base:record.base,value:record.value,id:record.id});stageRef.current=null;setStage(null);resolve()
          }}
        return {check,after:()=>after,current:()=>alive&&renderLatest.current.status==='ready'&&renderLatest.current.value===next.value,
          cancel:()=>abort(new HelperDisplayError('stale'),false),commit:()=>{
            check()
            if(stageRef.current)throw new HelperDisplayError('busy')
            committed=true;record.timer=setTimeout(()=>abort(new HelperDisplayError('timeout'),true),60000)
            stageRef.current=record;setLifecycleError(null);setStage(record)
          }}

      }catch(error){for(const lease of leases)lease.cancel();throw error}
    })
    return()=>{alive=false;const pending=stageRef.current;if(pending?.base===loaded.state)pending.abort(new HelperDisplayError('stale'),false);stop()}
  },[sessionId,props.messageId,rawText,streaming,loaded.state])
  const avatarUrl = avatar.state.status === 'ready' ? avatar.state.value.dataUrl : null
  // 交互卡渲染决策：会话绑定有值时优先于全局设置（renderOutputText 回包的
  // interactiveCards 即全局值）。HTML 抽取在服务端按全局开关做，会话关 → 不渲染
  // 封面 iframe；正文若已随抽取变空，回退原始文本，对齐全局关闭的「纯文本显示」。
  const interactive =
    props.interactiveCards ?? (rendered.state.status === 'ready' ? rendered.state.value.interactiveCards : true)
  const text =
    !streaming && rendered.state.status === 'ready'
      ? interactive || rendered.state.value.text || rendered.state.value.parts !== undefined
        ? rendered.state.value.text
        : stripDisplayMeta(rawText)
      : stripDisplayMeta(rawText)
  const regexDiagnostics=!streaming&&rendered.state.status==='ready'?rendered.state.value.regexDiagnostics:undefined
  const canSwipe =
    rendered.state.status === 'ready' ? rendered.state.value.canSwipeGreeting !== false : false
  const toast = useToast()
  const swipeBusy = useRef(false)
  const [swipeError, setSwipeError] = useState<string | null>(null)
  const swipeGreeting = async (index: number) => {
    if (swipeBusy.current) return
    if (!canSwipe) { setSwipeError(t('speech.swipeStarted')); return }
    if (!onSwipeGreeting) { setSwipeError(t('speech.navigationUnavailable')); return }
    swipeBusy.current = true
    setSwipeError(null)
    try {
      await onSwipeGreeting(index)
    } catch (cause) {
      setSwipeError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      swipeBusy.current = false
    }
  }

  /** 复制纯文本：优先 navigator.clipboard，沙盒/权限被拒时回退 execCommand。 */
  const onCopy = async () => {
    const plain = text || stripDisplayMeta(rawText)
    const fallback = () => {
      try {
        const ta = document.createElement('textarea')
        ta.value = plain
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        toast.show(ok ? t('speech.copied') : t('speech.copyFailed'))
      } catch {
        toast.show(t('speech.copyFailed'))
      }
    }
    try {
      await navigator.clipboard.writeText(plain)
      toast.show(t('speech.copied'))
    } catch {
      fallback()
    }
  }
  const registerDisplayGuard=(guard:(request:HelperDisplayRequest)=>Promise<HelperDisplayLease>)=>{
    displayGuards.current.add(guard);return()=>{displayGuards.current.delete(guard)}
  }
  const activeProjectionId=activeOverride?.id??baseProjectionId
  const projectionNodes:ReactNode[]=[]
  if(rendered.state.status==='ready'&&validStage?.phase!=='publishing'){
    const value=rendered.state.value
    projectionNodes.push(<DisplayProjection key={`display:${activeProjectionId}`} {...props} value={value} staging={false}
      refreshing={loaded.state.status!=='ready'}
      registerDisplayGuard={registerDisplayGuard}
      isCurrent={()=>!stageRef.current&&renderLatest.current.status==='ready'&&renderLatest.current.value===value}
      onComplete={()=>{}}
      onFailure={error=>setLifecycleError(displayFailure(error,t))}
      onSwipe={index=>void swipeGreeting(index)}/>)
  }else if(rendered.state.status!=='ready'){
    projectionNodes.push(<MarkdownText key={`fallback:${baseProjectionId}`} text={text||' '} streaming={Boolean(streaming)} labels={markdownLabels} fileMentions={props.fileMentions}/>)
  }
  if(validStage){
    const pending=stageRef.current
    projectionNodes.push(<DisplayProjection key={`display:${validStage.id}`} {...props} value={validStage.value}
      staging={validStage.phase==='preparing'} publishing={validStage.phase==='publishing'}
      registerDisplayGuard={registerDisplayGuard}
      isCurrent={()=>Boolean(pending&&!pending.settled&&stageRef.current===pending)}
      onComplete={()=>pending?.ready()}
      onFailure={error=>pending?.abort(error,true)}
      onPublished={()=>pending?.published()}
      onSwipe={index=>void swipeGreeting(index)}/>)
  }

  return (
    <div className="dsh-tavern-speech dsh-tavern-rise">
      <Avatar url={avatarUrl} name={name} size={40} className="dsh-tavern-speechAvatar" />
      <div className="dsh-tavern-speechBody">
        <div className="dsh-tavern-speechName">{name}</div>
        <Err message={swipeError} />
        <Err message={lifecycleError} />
        {loaded.state.status === 'error'&&<div>
          <Err message={t('speech.renderFailed',{error:loaded.state.message})}/>
          <Btn onClick={loaded.reload}>{t('speech.retryRender')}</Btn>
        </div>}
        {regexDiagnostics&&<details className="dsh-tavern-reason">
          <summary>{t('speech.regexFailures',{count:regexDiagnostics.total})}</summary>
          <ul>{regexDiagnostics.errors.map((error,index)=><li key={index}>{error.ruleName||error.ruleId}: {error.message}</li>)}</ul>
          {regexDiagnostics.total>regexDiagnostics.errors.length&&<div>{t('speech.regexFailuresMore',{count:regexDiagnostics.total-regexDiagnostics.errors.length})}</div>}
        </details>}
        {projectionNodes}
        {props.media}
        {!streaming&&loaded.state.status==='ready'&&rendered.state.status==='ready'&&(rendered.state.value.helper??rendered.state.value.helperContext)&&<ScriptChoices sessionId={sessionId} context={(rendered.state.value.helper??rendered.state.value.helperContext)!}/>}
      </div>
      <div className="dsh-tavern-speechCopy">
        <IconBtn label={t('speech.copy')} onClick={() => void onCopy()}>
          <IconCopyOutline16 />
        </IconBtn>
      </div>
      {toast.node}
    </div>
  )
}
