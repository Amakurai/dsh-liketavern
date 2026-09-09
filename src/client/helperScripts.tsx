/** 会话级隐藏后台脚本容器：管理入口统一放在设置；解绑或切换会话时卸载各自的 opaque-origin iframe。 */
import { useEffect,useState,useRef,useCallback } from 'react'
import { buildCardSrcDoc } from '../core/cardFrame.js'
import { helperScriptHtml,isNativeMvuFramework } from '../core/cardScript.js'
import {publishScriptStatus,clearScriptStatus,type ScriptRuntimeStatus} from './helperScriptStatus.js'
import { enabledHelperScripts,enabledHelperLibraries,type HelperScriptAsset,type HelperScript } from '../core/helperScripts.js'
import {HelperMvuRunner} from './helperMvuRunner.js'
import {openChildSession} from './openChild.js'
import { SpeechHtmlFrame } from './speech.js'
import {invalidateSessionBinding} from './cache.js'
import {BINDING_CHANGED_EVENT} from './actions.js'
import { watchHelperScripts,watchHelperScriptAssets } from './helperScriptNotifications.js'
import { notifyHelperStory,watchHelperStory } from './helperNotifications.js'
import { useT } from './i18n.js'
import {cardVariableLabels} from './cardVariableLabels.js'
import { useLoader } from './util.js'
import { CARD_VARIABLE_STYLES } from './styles.js'
import type { TavernRemote } from './types.js'

export function HelperScripts(props:{remote:TavernRemote;sessionId:string;sessions?:{open(id:string):void;refresh?:()=>Promise<void>};onCancel?:()=>Promise<void>}) {
  const {remote,sessionId}=props,t=useT()
  const loader=useLoader(()=>remote.getHelperScriptBundle({sessionId}),[sessionId],true)
  const [ready,setReady]=useState<Record<string,string>>({})
  const [failures,setFailures]=useState<Record<string,{version:string;error:string}>>({})
  const owner=useRef(Symbol('script-runtime'))
  const [mvu,setMvu]=useState<{error:string|null;busy:boolean}>({error:null,busy:false})
  const retryMvu=useRef<()=>void>(()=>{})
  const mvuStatus=useCallback((value:{error:string|null;busy:boolean;retry:()=>void})=>{retryMvu.current=value.retry;setMvu(current=>current.error===value.error&&current.busy===value.busy?current:{error:value.error,busy:value.busy})},[])
  const bundle=loader.state.status==='ready'?loader.state.value:undefined
  useEffect(()=>bundle?watchHelperScripts(sessionId,bundle.storyId,()=>loader.reload()):undefined,[sessionId,bundle?.storyId,loader.reload])
  const libraries:HelperScriptAsset[]=bundle?(bundle.libraries??[{target:{type:'character',cardId:bundle.cardId},revision:bundle.revision,trees:bundle.trees}]):[]
  let scripts:HelperScript[]=[],scriptError:string|null=null
  try{scripts=enabledHelperLibraries(libraries)}catch(error){scriptError=error instanceof Error?error.message:String(error)}
  const waitingForMessage=Boolean(bundle?.enabled&&bundle.messageId===null&&!bundle.snapshot&&!bundle.runtimeError&&!scriptError&&(scripts.length>0||bundle.helperMvu)&&scripts.length<=32)
  useEffect(()=>{
    if(!waitingForMessage||!bundle)return
    // 首条消息出现后启动等待中的脚本；已运行的沙箱自行刷新数据，不因普通剧情通知重启。
    let requested=false
    const stop=watchHelperStory(sessionId,bundle.storyId,()=>{if(!requested){requested=true;loader.reload()}})
    const timer=setInterval(()=>loader.reload(),1000)
    return()=>{stop();clearInterval(timer)}
  },[sessionId,bundle?.storyId,waitingForMessage,loader.reload])
  const scriptVersion=JSON.stringify(libraries.map(library=>[library.target,library.revision]))
  useEffect(()=>watchHelperScriptAssets(target=>{if(libraries.some(library=>JSON.stringify(library.target)===JSON.stringify(target)))loader.reload()}),[loader.reload,scriptVersion,bundle?.cardId])
  const allReady=!scriptError&&!bundle?.runtimeError&&scripts.length<=32&&scripts.every(script=>ready[script.id]===scriptVersion&&failures[script.id]?.version!==scriptVersion)
  const status:ScriptRuntimeStatus={sessionId,cardId:bundle?.cardId??'',nativeMvu:bundle?.helperMvu===true,mvuBusy:mvu.busy,mvuError:mvu.error??undefined,
    state:loader.state.status==='error'||scriptError||bundle?.runtimeError||mvu.error||scripts.some(script=>failures[script.id]?.version===scriptVersion)?'error':!bundle?'loading':!bundle.enabled?'disabled':waitingForMessage?'waiting':'running',
    error:loader.state.status==='error'?loader.state.message:scriptError??bundle?.runtimeError??undefined,
    scripts:scripts.map(script=>({id:script.id,name:script.name||script.id,native:isNativeMvuFramework(script.content),state:failures[script.id]?.version===scriptVersion?'error':ready[script.id]===scriptVersion?'ready':'loading',error:failures[script.id]?.version===scriptVersion?failures[script.id]?.error:undefined}))}
  const statusKey=JSON.stringify(status)
  useEffect(()=>{publishScriptStatus(owner.current,status,()=>retryMvu.current())},[statusKey])
  useEffect(()=>()=>clearScriptStatus(owner.current,sessionId),[sessionId])
  return <span className="dsh-tavern-scriptHost" hidden>
    {bundle?.enabled&&bundle.helperMvu&&bundle.snapshot&&<HelperMvuRunner key={scriptVersion} remote={remote} sessionId={sessionId} storyId={bundle.storyId} snapshot={bundle.snapshot} ready={allReady} onStatus={mvuStatus} onCancel={props.onCancel}/>}
    <div>
      {bundle?.enabled&&!bundle.runtimeError&&!scriptError&&bundle.snapshot&&bundle.messageId!==null&&scripts.length<=32&&scripts.map(script=>{
        const snapshot=bundle.snapshot!,messageId=bundle.messageId!
        const srcDoc=buildCardSrcDoc(helperScriptHtml(script.content),{greetings:[],greetingIndex:0,helperSnapshot:snapshot,
          worldbooks:bundle.worldbooks,scriptLibraries:bundle.scriptContext,scriptLibraryLabels:{saving:t('speech.scriptSaving'),saved:t('speech.scriptSaved'),failed:t('speech.scriptSaveFailed')},
          scriptContext:{script,trees:bundle.trees,libraryType:libraries.find(library=>enabledHelperScripts(library.trees).some(item=>item.id===script.id))?.target.type,libraries:libraries.map(library=>({type:library.target.type,trees:library.trees}))},helperContext:{canSwipe:false,scriptFrame:true},connectHosts:bundle.whitelist,variableStyles:CARD_VARIABLE_STYLES,
          persistenceLabels:{saving:t('speech.helperSaving'),saved:t('speech.helperSaved'),failed:t('speech.helperSaveFailed'),refresh:t('speech.helperRefresh')},
          helperLabels:{diagnostics:t('speech.helperMessages'),unsupported:t('speech.helperUnsupported')},
          variableLabels:cardVariableLabels(t,t('speech.helperDataNote'))})
        return <section key={scriptVersion+script.id}>
          {<SpeechHtmlFrame srcDoc={srcDoc} title={script.name||script.id} widget compact
            onScriptError={error=>setFailures(current=>({...current,[script.id]:{version:scriptVersion,error}}))}
            onScriptReady={value=>setReady(current=>current[script.id]===(value?scriptVersion:'')?current:{...current,[script.id]:value?scriptVersion:''})}
            helperBinding={{sessionId,storyId:snapshot.storyId}}
            onMessageBranch={props.sessions?async branch=>{await openChildSession(props.sessions!,branch.childSessionId,branch.title)}:undefined}
            onMessageEdit={async request=>{const result=await remote.editHelperMessages({...request,sessionId,messageId});if(!result.ok)throw new Error(result.error.message);if(result.value.snapshot)notifyHelperStory(sessionId,result.value.snapshot.storyId);return result.value}}
            onWorldbookBind={async request=>{const result=await remote.rebindHelperWorldbooks({...request,sessionId,messageId});if(!result.ok)throw new Error(result.error.message);invalidateSessionBinding(sessionId);window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT,{detail:sessionId}));return result.value}}
            onWorldbookRequest={async request=>{const result=await remote.helperWorldbookOperation({...request,sessionId,messageId});if(!result.ok)throw new Error(result.error.message);return result.value}}
            onWorldbookRefresh={async()=>{const result=await remote.getHelperWorldbookContext({sessionId,storyId:snapshot.storyId});if(!result.ok)throw new Error(result.error.message);return result.value}}
            onScriptCommit={async request=>{const result=await remote.commitSessionHelperScripts({...request,sessionId});if(!result.ok)throw new Error(result.error.message);return result.value}}
            onScriptRefresh={async()=>{const result=await remote.getSessionHelperScripts({sessionId,storyId:snapshot.storyId});if(!result.ok)throw new Error(result.error.message);return result.value}}
            onHelperCommit={async request=>{const result=await remote.commitHelperVariables({...request,sessionId,messageId});if(!result.ok)throw new Error(result.error.message);notifyHelperStory(sessionId,result.value.storyId);return result.value}}
            onHelperRefresh={async()=>{const result=await remote.getHelperSnapshot({sessionId,messageId});if(!result.ok)throw new Error(result.error.message);return result.value}}/>}
        </section>
      })}
    </div>
  </span>
}
