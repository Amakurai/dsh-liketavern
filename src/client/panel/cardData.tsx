/** 设置页的剧情变量管理：显式选择角色和剧情，备份已保存快照；恢复经原有楼层 WAL/CAS，草稿及失败留在设置。 */
import {useState} from 'react'
import {parseHelperVariableBackup,helperVariableRestoreChanges} from '../../core/helperVariableBackup.js'
import type {HelperSnapshot} from '../../core/helperRuntime.js'
import type {HelperScriptAsset} from '../../core/helperScripts.js'
import {DraftScope,useDraftGuard} from '../drafts.js'
import {useDraftState} from '../draftPersistence.js'
import {HelperScriptEditor} from '../helperScriptEditor.js'
import {notifyHelperStory} from '../helperNotifications.js'
import {notifyHelperScripts} from '../helperScriptNotifications.js'
import {useT} from '../i18n.js'
import type {TavernRemote} from '../types.js'
import {Btn,ConfirmDialog,Err,Muted,SaveBar,Section,Select,SettingsRow,Skeleton,downloadJson,useLoader,useToast} from '../util.js'

export function CardDataSettings({remote}:{remote:TavernRemote}){
  const t=useT()
  const [cardId,setCardId]=useDraftState('card-data:card','')
  const [storyId,setStoryId]=useDraftState('card-data:story','')
  const chars=useLoader(()=>remote.listCharacters({}),[])
  const stories=useLoader(()=>remote.listStories({cardId}),[cardId],Boolean(cardId))
  const items=stories.state.status==='ready'?stories.state.value.items:[]
  const story=items.find(item=>item.id===storyId)
  return <Section title={t('speech.cardDataTitle')} description={t('settings.cards.variablesDesc')}>
    <DraftScope>{request=><>
      <SettingsRow title={t('settings.cards.variableCharacter')}><Select value={cardId} title={t('settings.cards.variableCharacter')}
        options={[{value:'',label:t('settings.cards.variableChoose')},...(chars.state.status==='ready'?chars.state.value.items.map(item=>({value:item.cardId,label:item.name})):[])]}
        onChange={value=>request(()=>{setCardId(value);setStoryId('')})}/></SettingsRow>
      <SettingsRow title={t('memory.story')}><Select value={storyId} title={t('memory.story')} disabled={!cardId||stories.state.status!=='ready'}
        options={[{value:'',label:t('settings.cards.variableChoose')},...items.map((item,index)=>({value:item.id,label:t('memory.storyLabel',{index:index+1,date:new Date(item.createdAt).toLocaleString()})}))]}
        onChange={value=>request(()=>setStoryId(value))}/></SettingsRow>
      {(chars.state.status==='loading'||stories.state.status==='loading')&&<Skeleton height={40}/>}
      <Err message={chars.state.status==='error'?chars.state.message:stories.state.status==='error'?stories.state.message:null}/>
      {(chars.state.status==='error'||stories.state.status==='error')&&<Btn onClick={()=>{chars.reload();stories.reload()}}>{t('action.retry')}</Btn>}
      {story?<StoryVariableSettings key={JSON.stringify([cardId,storyId,story.sessionId])} remote={remote} cardId={cardId} storyId={storyId} sessionId={story.sessionId}/>:<Muted>{t('settings.cards.variableChooseStory')}</Muted>}
    </>}</DraftScope>
  </Section>
}

export function StoryVariableSettings(props:{remote:TavernRemote;cardId:string;storyId:string;sessionId:string}){
  const {remote,sessionId,storyId}=props,t=useT()
  const loaded=useLoader(async()=>{
    const events=await remote.getHelperEventState({sessionId,storyId})
    if(!events.ok)return events
    const message=[...events.value.messages].reverse().find(item=>item.role==='assistant')
    if(!message)throw new Error(t('settings.cards.variableNoMessage'))
    const result=await remote.getHelperSnapshot({sessionId,messageId:message.seq})
    if(!result.ok)return result
    if(result.value.storyId!==storyId)throw new Error(t('speech.helperStoryChanged'))
    return {ok:true as const,value:{snapshot:result.value,messageId:message.seq}}
  },[sessionId,storyId])
  const [library,setLibrary]=useState<HelperScriptAsset|null>(null)
  const [scriptError,setScriptError]=useState<string|null>(null),[scriptBusy,setScriptBusy]=useState(false)
  const scriptGuard=useDraftGuard(false,scriptBusy)
  const editScripts=async()=>{
    setScriptBusy(true);setScriptError(null)
    try{
      const result=await remote.getHelperScriptLibrary({target:{type:'character',cardId:props.cardId}})
      if(!result.ok)throw new Error(result.error.message)
      setLibrary(result.value)
    }catch(error){setScriptError(error instanceof Error?error.message:String(error))}finally{setScriptBusy(false)}
  }
  return <>
    {scriptGuard.confirmation}
    <SettingsRow title={t('speech.scriptEditor')}><Btn disabled={scriptBusy} onClick={()=>void editScripts()}>{t('speech.scriptEditor')}</Btn></SettingsRow>
    <Err message={scriptError}/>
    {library&&<HelperScriptEditor remote={remote} library={library} onClose={()=>setLibrary(null)} onSaved={()=>notifyHelperScripts(sessionId,storyId)}/>}
    {loaded.state.status==='loading'&&<Skeleton height={100}/>}
    {loaded.state.status==='error'&&<><Err message={loaded.state.message}/><Btn onClick={loaded.reload}>{t('action.retry')}</Btn></>}
    {loaded.state.status==='ready'&&<VariableBackupEditor key={loaded.state.value.snapshot.historyRevision} remote={remote} sessionId={sessionId}
      snapshot={loaded.state.value.snapshot} messageId={loaded.state.value.messageId} onRefresh={loaded.reload}/>}
  </>
}

export function VariableBackupEditor(props:{remote:TavernRemote;sessionId:string;messageId:number;snapshot:HelperSnapshot;onRefresh:()=>void}){
  const t=useT(),toast=useToast()
  const [snapshot,setSnapshot]=useState(props.snapshot)
  const [text,setText]=useDraftState(`card-data:backup:${JSON.stringify([props.sessionId,snapshot.storyId])}`,'')
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false)
  const guard=useDraftGuard(Boolean(text.trim()),busy)
  const restore=async()=>{
    setConfirm(false);setBusy(true);setError(null)
    try{
      const target=parseHelperVariableBackup(text,snapshot.currentMessageId)
      const changes=helperVariableRestoreChanges(snapshot.scopes,target)
      if(!snapshot.writable)throw new Error(t('settings.cards.variableReadOnly'))
      if(changes.length){
        const result=await props.remote.commitHelperVariables({sessionId:props.sessionId,messageId:props.messageId,storyId:snapshot.storyId,historyRevision:snapshot.historyRevision,changes})
        if(!result.ok)throw new Error(result.error.message)
        if(result.value.storyId!==snapshot.storyId)throw new Error(t('speech.helperStoryChanged'))
        setSnapshot(result.value);notifyHelperStory(props.sessionId,snapshot.storyId)
      }else{
        // 旧快照相等不能证明服务器仍相等；只读复核后才提示无需恢复，不清掉冲突草稿。
        const fresh=await props.remote.getHelperSnapshot({sessionId:props.sessionId,messageId:props.messageId})
        if(!fresh.ok)throw new Error(fresh.error.message)
        if(fresh.value.storyId!==snapshot.storyId||fresh.value.historyRevision!==snapshot.historyRevision)throw new Error(t('speech.helperStoryChanged'))
        if(!fresh.value.writable)throw new Error(t('settings.cards.variableReadOnly'))
        if(helperVariableRestoreChanges(fresh.value.scopes,target).length)throw new Error(t('settings.cards.variableConflict'))
        setSnapshot(fresh.value)
      }
      setText('');guard.clearDraft();toast.show(t(changes.length?'speech.variableSaved':'settings.cards.variableUnchanged'))
    }catch(error){setError(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
  }
  return <>
    {toast.node}{guard.confirmation}
    <Muted>{t(snapshot.writable?'settings.cards.variableLoaded':'settings.cards.variableReadOnly')}</Muted>
    <SettingsRow title={t('speech.helperRefresh')} description={t('settings.cards.variableRefreshDesc')}><Btn disabled={busy} onClick={()=>guard.request(props.onRefresh)}>{t('speech.helperRefresh')}</Btn></SettingsRow>
    <SettingsRow title={t('settings.cards.variableExport')}><Btn disabled={busy} onClick={()=>downloadJson('tavern-variables.json',{version:1,scopes:snapshot.scopes},0)}>{t('settings.cards.variableExport')}</Btn></SettingsRow>
    <SettingsRow stacked title={t('speech.cardDataRestore')} description={t('settings.cards.variableRestoreDesc')}>
      <textarea className="dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont" aria-label={t('speech.cardDataText')} value={text} disabled={busy} onChange={event=>setText(event.target.value)}/>
    </SettingsRow>
    <Err message={error}/>
    <SaveBar><Btn disabled={busy||!text.trim()} onClick={()=>guard.request(()=>setText(''))}>{t('action.cancel')}</Btn>
      <Btn primary disabled={busy||!snapshot.writable||!text.trim()} onClick={()=>{try{helperVariableRestoreChanges(snapshot.scopes,parseHelperVariableBackup(text,snapshot.currentMessageId));setError(null);setConfirm(true)}catch(error){setError(error instanceof Error?error.message:String(error))}}}>{t('speech.cardDataRestore')}</Btn></SaveBar>
    <ConfirmDialog open={confirm} title={t('speech.cardDataRestore')} description={t('settings.cards.variableRestoreConfirm')} busy={busy}
      onCancel={()=>setConfirm(false)} onConfirm={()=>void restore()}/>
  </>
}
