/** 设置中的脚本资产管理：无需绑定会话，按全局、角色与预设选择独立脚本库，复用带草稿保护的编辑器。 */
import { useRef, useState,useSyncExternalStore } from 'react'
import {scriptStatusStore,retryScriptMvu} from '../helperScriptStatus.js'
import type { HelperScriptAsset, HelperScriptTarget } from '../../core/helperScripts.js'
import type { TavernRemote } from '../types.js'
import { HelperScriptEditor } from '../helperScriptEditor.js'
import { useT } from '../i18n.js'
import { Btn, Err, Muted, Section, Select, Skeleton, useLoader } from '../util.js'

export function ScriptSettings({remote}:{remote:TavernRemote}) {
  const t=useT()
  const runtimes=useSyncExternalStore(scriptStatusStore.subscribe,scriptStatusStore.getSnapshot,scriptStatusStore.getSnapshot)
  const characters=useLoader(()=>remote.listCharacters({}),[])
  const presets=useLoader(()=>remote.listPresets({}),[])
  const [cardId,setCardId]=useState(''),[presetId,setPresetId]=useState('')
  const [editing,setEditing]=useState<HelperScriptAsset|null>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
  const opening=useRef(false)
  const [openingType,setOpeningType]=useState<HelperScriptTarget['type']|null>(null)
  const open=async(target:HelperScriptTarget)=>{
    if(opening.current)return
    opening.current=true;setOpeningType(target.type);setBusy(true);setError(null)
    try {
      const result=await remote.getHelperScriptLibrary({target})
      if(!result.ok)throw new Error(result.error.message)
      setEditing(result.value)
    }catch(error){setError(error instanceof Error?error.message:String(error))}finally{opening.current=false;setOpeningType(null);setBusy(false)}
  }
  const target=editing?.target
  const editorLabel=target?.type==='character'&&characters.state.status==='ready'?characters.state.value.items.find(card=>card.cardId===target.cardId)?.name:target?.type==='preset'&&presets.state.status==='ready'?presets.state.value.items.find(preset=>preset.id===target.presetId)?.name:undefined
  const action=(type:HelperScriptTarget['type'])=>t(openingType===type?'settings.scripts.loading':'settings.scripts.open')
  return <Section title={t('settings.sub.scripts')} description={t('settings.scripts.desc')}>
    <section className="dsh-tavern-scriptRuntime" aria-label={t('settings.scripts.runtime')}>
      <h4>{t('settings.scripts.runtime')}</h4>
      {!runtimes.length&&<Muted>{t('settings.scripts.noRuntime')}</Muted>}
      {runtimes.map(runtime=><div key={runtime.sessionId}>
        <strong>{characters.state.status==='ready'?characters.state.value.items.find(card=>card.cardId===runtime.cardId)?.name??t('settings.scripts.current'):t('settings.scripts.current')}</strong>
        <Muted>{t(`settings.scripts.runtime.${runtime.state}`)}</Muted><Err message={runtime.error??null}/>
        {runtime.scripts.some(script=>script.native)&&<Muted>{t(runtime.nativeMvu?'settings.scripts.nativeOn':'settings.scripts.nativeOff')}</Muted>}
        {runtime.nativeMvu&&<Muted>{t(runtime.mvuError?'speech.mvuRetry':runtime.mvuBusy?'speech.mvuRunning':runtime.scripts.every(script=>script.state==='ready')?'speech.mvuReady':'speech.mvuWaiting')}</Muted>}
        <Err message={runtime.mvuError??null}/>
        {runtime.mvuError&&<Btn onClick={()=>retryScriptMvu(runtime.sessionId)}>{t('speech.mvuRetry')}</Btn>}
        <ul>{runtime.scripts.map(script=><li key={script.id}><span>{script.name}</span><span className="dsh-tavern-scriptRuntimeStatus">{t(`settings.scripts.runtime.${script.state}`)}</span>{script.error&&<Err message={script.error}/>}</li>)}</ul>
      </div>)}
    </section>
    <div className="dsh-tavern-scriptLibraries" aria-busy={busy}>
      <section className="dsh-tavern-scriptLibrary">
        <div className="dsh-tavern-scriptLibraryIntro"><h4>{t('settings.scripts.global')}</h4><Muted>{t('settings.scripts.globalDesc')}</Muted></div>
        <div className="dsh-tavern-scriptLibraryActions"><Btn size="md" disabled={busy} onClick={()=>void open({type:'global'})}>{action('global')}</Btn></div>
      </section>
      <section className="dsh-tavern-scriptLibrary">
        <div className="dsh-tavern-scriptLibraryIntro"><h4>{t('settings.scripts.character')}</h4><Muted>{t('settings.scripts.characterDesc')}</Muted></div>
        <div className="dsh-tavern-scriptLibraryActions">
          {characters.state.status==='loading'&&<Skeleton/>}
          {characters.state.status==='error'&&<><Err message={characters.state.message}/><Btn onClick={characters.reload}>{t('action.retry')}</Btn></>}
          {characters.state.status==='ready'&&(characters.state.value.items.length?<Select size="md" disabled={busy} title={t('speech.scriptEditor')} value={cardId} onChange={value=>{setCardId(value);setError(null)}} options={[{value:'',label:t('settings.scripts.chooseCharacter')},...characters.state.value.items.map(card=>({value:card.cardId,label:card.name}))]}/>:<Muted>{t('settings.scripts.noCharacters')}</Muted>)}
          <Btn size="md" disabled={busy||!cardId} onClick={()=>void open({type:'character',cardId})}>{action('character')}</Btn>
        </div>
      </section>
      <section className="dsh-tavern-scriptLibrary">
        <div className="dsh-tavern-scriptLibraryIntro"><h4>{t('settings.scripts.preset')}</h4><Muted>{t('settings.scripts.presetDesc')}</Muted></div>
        <div className="dsh-tavern-scriptLibraryActions">
          {presets.state.status==='loading'&&<Skeleton/>}
          {presets.state.status==='error'&&<><Err message={presets.state.message}/><Btn onClick={presets.reload}>{t('action.retry')}</Btn></>}
          {presets.state.status==='ready'&&(presets.state.value.items.length?<Select size="md" disabled={busy} title={t('settings.scripts.preset')} value={presetId} onChange={value=>{setPresetId(value);setError(null)}} options={[{value:'',label:t('settings.scripts.choosePreset')},...presets.state.value.items.map(preset=>({value:preset.id,label:preset.name}))]}/>:<Muted>{t('settings.scripts.noPresets')}</Muted>)}
          <Btn size="md" disabled={busy||!presetId} onClick={()=>void open({type:'preset',presetId})}>{action('preset')}</Btn>
        </div>
      </section>
    </div>
    <Err message={error}/>
    {editing&&<HelperScriptEditor remote={remote} library={editing} label={editorLabel} onClose={()=>setEditing(null)} onSaved={()=>{}}/>}
  </Section>
}
