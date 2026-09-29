/** 会话原生 MVU 调度器：后台轮询持久任务，绑定脚本就绪与租约，沙箱计算完成后才提交结果。 */
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react'
import {buildCardSrcDoc} from '../core/cardFrame.js'
import {helperJson,helperRecord} from '../core/helperRuntime.js'
import type {HelperMvuWork} from '../core/helperMvu.js'
import type {HelperSnapshot} from '../core/helperRuntime.js'
import {attachHelperEvents} from './helperEventRouter.js'
import {notifyHelperStory} from './helperNotifications.js'
import {useT} from './i18n.js'
import {Btn,Err,Muted} from './util.js'
import type {TavernRemote} from './types.js'

export function HelperMvuRunner(props:{remote:TavernRemote;sessionId:string;storyId:string;snapshot:HelperSnapshot;ready:boolean;onStatus?:(status:{error:string|null;busy:boolean;retry:()=>void})=>void;onCancel?:()=>Promise<void>}){
  const t=useT(),frame=useRef<HTMLIFrameElement|null>(null),live=useRef(props)
  live.current=props
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[restartRequired,setRestartRequired]=useState(false)
  const [canceling,setCanceling]=useState(false),[cancelError,setCancelError]=useState<string|null>(null),cancelPending=useRef(false)
  const cancelWaiting=async()=>{
    if(!props.onCancel||cancelPending.current)return
    cancelPending.current=true;setCanceling(true);setCancelError(null)
    try{await props.onCancel()}catch(value){setCancelError(String(value instanceof Error?value.message:value))}
    finally{cancelPending.current=false;setCanceling(false)}
  }
  const retry=useRef<()=>void>(()=>{})
  useEffect(()=>{props.onStatus?.({error,busy,retry:()=>retry.current()})},[error,busy,props.onStatus])
  const srcDoc=useMemo(()=>buildCardSrcDoc('',{greetings:[],greetingIndex:0,helperSnapshot:props.snapshot,mvuRunner:true}),[props.sessionId,props.storyId])
  useLayoutEffect(()=>{
    let active=true,frameRuntime='',running=false,polling=false,failed=false,committing=false
    let work:HelperMvuWork|undefined,result:unknown,deadline=0,renewAt=0,requestId='',restart=false
    const runtimeId=crypto.randomUUID(),{sessionId,storyId}=props
    const requests=new Set<()=>void>()
    // RPC 无响应也必须释放本地在途锁；迟到响应只结束原 Promise，不能覆盖重试后的任务。
    const request=async<T,>(call:()=>Promise<T>):Promise<T>=>{
      let timer:ReturnType<typeof setTimeout>|undefined,cancel!:()=>void
      const timeout=new Promise<never>((_resolve,reject)=>{
        cancel=()=>reject(new Error(t('speech.mvuRequestTimeout')))
        timer=setTimeout(cancel,20000);requests.add(cancel)
      })
      try{return await Promise.race([Promise.resolve().then(call),timeout])}
      finally{clearTimeout(timer);requests.delete(cancel)}
    }
    const send=(message:Record<string,unknown>)=>{if(active)frame.current?.contentWindow?.postMessage({source:'dsh-tavern-card',...message},'*')}
    const valid=()=>active&&running&&!failed&&live.current.ready&&Boolean(work?.job)&&Date.now()<deadline
    const endpoint=attachHelperEvents(sessionId,storyId,send,{current:valid,snapshot:()=>work?.snapshot})
    const fail=(value:unknown)=>{if(active){failed=true;running=false;setBusy(false);setError(String(value instanceof Error?value.message:value).slice(0,2000))}}
    const complete=()=>{
      work=undefined;result=undefined;running=false;failed=false;restart=false;setRestartRequired(false);setBusy(false);setError(null)
      notifyHelperStory(sessionId,storyId)
    }
    const commit=async()=>{
      if(!work?.job||!work.token||result===undefined||committing)return
      if(!live.current.ready)throw new Error(t('speech.mvuScriptsNotReady'))
      committing=true
      try{
        const payload={sessionId,storyId,runtimeId,jobId:work.job.id,token:work.token,data:result}
        const response=await request(()=>live.current.remote.commitHelperMvuJob(payload))
        if(!response.ok)throw new Error(response.error.message)
        if(!active)return
        complete()
      }finally{committing=false}
    }
    const poll=async()=>{
      if(!active||polling||committing||!frameRuntime||!live.current.ready)return
      if(failed&&result===undefined)return
      if(running&&Date.now()>deadline){fail(t('speech.mvuExecutionTimeout'));return}
      if(work&&Date.now()<renewAt)return
      polling=true
      const expectedWork=work
      try{
        const response=await request(()=>live.current.remote.prepareHelperMvuJob({sessionId,storyId,runtimeId}))
        if(!active||work!==expectedWork)return
        if(!response.ok)throw new Error(response.error.message)
        const next=response.value
        renewAt=Date.now()+20000
        if(work){
          if(next.job?.id!==work.job?.id||next.token!==work.token){
            const previous=work,receipt=next.completed?.find(item=>item.id===previous.job?.id)
            if(receipt&&result!==undefined){
              const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(helperJson(result))))
              if(!active||work!==previous)return
              const hex=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
              if(hex===receipt.digest){complete();return}
            }
            restart=true;setRestartRequired(true)
            throw new Error(t('speech.mvuLeaseChanged'))
          }
          return
        }
        setBusy(next.status==='waiting')
        if(failed||!live.current.ready||next.status!=='pending'||!next.job||!next.token||!next.snapshot)return
        work=next;running=true;deadline=Date.now()+300000;requestId=crypto.randomUUID();setBusy(true);setError(null)
        send({action:'helperMvuRun',runtimeId:frameRuntime,requestId,work:next})
      }catch(value){if(work===expectedWork)fail(value)}finally{polling=false}
    }
    const receive=(event:MessageEvent)=>{
      if(!active||event.source!==frame.current?.contentWindow||!helperRecord(event.data)||event.data.source!=='dsh-tavern-card')return
      const value=event.data
      if(typeof value.action==='string'&&value.action.startsWith('helperEvent')){endpoint.receive(value);return}
      if(value.action==='helperMvuReady'&&endpoint.matchesRuntime(value.runtimeId)){
        if(frameRuntime&&frameRuntime!==value.runtimeId){fail(t('speech.mvuSandboxChanged'));return}
        frameRuntime=String(value.runtimeId);void poll();return
      }
      if(value.action==='helperSnapshotGet'&&typeof value.requestId==='string'&&value.storyId===storyId){
        send({action:'helperSnapshotResult',requestId:value.requestId,ok:true,snapshot:work?.snapshot??live.current.snapshot});return
      }
      if(value.action!=='helperMvuResult'||!endpoint.matchesRuntime(value.runtimeId)||value.requestId!==requestId||!running||result!==undefined)return
      if(!valid()){fail(t('speech.mvuTaskChanged'));return}
      if(value.ok!==true){fail(value.error);return}
      try{result=helperJson(value.data);void commit().catch(fail)}catch(error){fail(error)}
    }
    retry.current=()=>{
      failed=false;setError(null)
      if(restart){restart=false;setRestartRequired(false);result=undefined;work=undefined;running=false;renewAt=0;void poll()}
      else if(result!==undefined){setBusy(true);void commit().catch(fail)}
      else{work=undefined;running=false;renewAt=0;void poll()}
    }
    window.addEventListener('message',receive)
    const timer=setInterval(()=>{void poll()},1000)
    return()=>{active=false;clearInterval(timer);for(const cancel of requests)cancel();endpoint.dispose();window.removeEventListener('message',receive);retry.current=()=>{}}
  },[props.sessionId,props.storyId,srcDoc])
  return <span>
    <Muted>{t(!props.ready?'speech.mvuWaiting':busy?'speech.mvuRunning':'speech.mvuReady')}</Muted>
    <Err message={error}/>
    <Err message={cancelError}/>
    {props.onCancel&&(!props.ready||busy||error)&&<Btn disabled={canceling} onClick={()=>{void cancelWaiting()}}>{t('speech.mvuCancel')}</Btn>}
    {error&&<Btn onClick={()=>retry.current()}>{t(restartRequired?'speech.mvuRestart':'speech.mvuRetry')}</Btn>}
    <iframe ref={frame} srcDoc={srcDoc} sandbox="allow-scripts" title={t('speech.mvuTitle')} hidden/>
  </span>
}
