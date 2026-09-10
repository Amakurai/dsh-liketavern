/** 共享脚本库编辑器：草稿、导入导出、文件夹及持久开关；保存走资产修订校验，运行变量不写回共享资产。 */
import { useEffect, useId, useRef, useState } from 'react'
import { notifyHelperScriptAssets } from './helperScriptNotifications.js'
import { parseHelperScriptTrees,importHelperScriptFile,exportHelperScriptTrees,type HelperScript,type HelperScriptLibrary,type HelperScriptTree,type HelperScriptAsset,type HelperScriptTarget } from '../core/helperScripts.js'
import { useDraftGuard } from './drafts.js'
import { PersistentEditor,useDraftState } from './draftPersistence.js'
import { useT } from './i18n.js'
import { Btn,ConfirmDialog,Dialog,Err,FileBtn,Muted,SaveBar,SearchInput,Select,SettingsRow,Tabs,Toggle,downloadJson,useToast } from './util.js'
import type { TavernRemote } from './types.js'

type ScriptEditorProps={label?:string;remote:TavernRemote;library:HelperScriptLibrary|HelperScriptAsset;onClose:()=>void;onSaved:()=>void}
const libraryTarget=(library:ScriptEditorProps['library']):HelperScriptTarget=>'target' in library?library.target:{type:'character',cardId:library.cardId}
const draftScope=(target:HelperScriptTarget)=>`helper-scripts:${target.type==='character'?target.cardId:JSON.stringify(target)}`
export function HelperScriptEditor(props:ScriptEditorProps) {
  return <PersistentEditor remote={props.remote} scope={draftScope(libraryTarget(props.library))}>
    <HelperScriptEditorBody {...props}/>
  </PersistentEditor>
}
export function HelperScriptEditorBody(props:ScriptEditorProps) {
  const target=libraryTarget(props.library)
  const t=useT(),toast=useToast(),tabsId=useId()
  const saving=useRef(false)
  const [query,setQuery]=useState(''),[section,setSection]=useState('code')
  // 设置面板内嵌时 PersistentEditor 复用父级快照，外层 scope 不生效；草稿键必须自带目标身份，
  // 否则全局库的未保存草稿会在打开另一张卡的脚本库时被当作它的草稿恢复并保存进错误的卡。
  const scope=draftScope(target)
  const [trees,setTrees]=useDraftState<HelperScriptTree[]>(`${scope}:trees`,props.library.trees)
  const [revision,setRevision]=useDraftState(`${scope}:revision`,props.library.revision)
  const [baseline,setBaseline]=useDraftState(`${scope}:baseline`,JSON.stringify(props.library.trees))
  const [dataTexts,setDataTexts]=useDraftState<Record<string,string>>(`${scope}:data`,{})
  const [selected,setSelected]=useState<string|null>(props.library.trees[0]?.id??null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[removing,setRemoving]=useState(false)
  const flat=trees.flatMap(tree=>tree.type==='folder'?[tree,...tree.scripts]:[tree])
  useEffect(()=>{if(!flat.some(item=>item.id===selected))setSelected(flat[0]?.id??null)},[trees,selected])
  const current=flat.find(tree=>tree.id===selected)
  const siblings=current?trees.find(tree=>tree.type==='folder'&&tree.scripts.some(script=>script.id===current.id)):undefined
  const peers=siblings?.type==='folder'?siblings.scripts:trees
  const position=peers.findIndex(item=>item.id===selected)
  const matches=(item:HelperScriptTree)=>item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const visible=trees.filter(tree=>matches(tree)||tree.type==='folder'&&tree.scripts.some(matches))
  const scriptCount=flat.filter(tree=>tree.type==='script').length
  const dirty=JSON.stringify(trees)!==baseline||Object.keys(dataTexts).length>0
  const guard=useDraftGuard(dirty,busy)
  const update=(id:string,change:(tree:HelperScriptTree)=>HelperScriptTree)=>setTrees(items=>items.map(tree=>tree.id===id?change(tree):tree.type==='folder'?{...tree,scripts:tree.scripts.map(script=>script.id===id?change(script) as HelperScript:script)}:tree))
  const materialize=()=>parseHelperScriptTrees(trees.map(tree=>tree.type==='script'?scriptData(tree):{...tree,scripts:tree.scripts.map(scriptData)}))
  const scriptData=(script:HelperScript):HelperScript=>{
    if(!Object.hasOwn(dataTexts,script.id))return script
    try {
      const data:unknown=JSON.parse(dataTexts[script.id]!)
      if(data===null||typeof data!=='object'||Array.isArray(data))throw new Error('object required')
      return {...script,data:data as HelperScript['data']}
    }catch{
      setQuery('');setSelected(script.id);setSection('data')
      throw new Error(t('speech.scriptInvalidData',{name:script.name||script.id}))
    }
  }
  const add=(folder:boolean)=>{
    const id=crypto.randomUUID()
    const next=parseHelperScriptTrees([{id,type:folder?'folder':'script',name:t(folder?'speech.scriptNewFolder':'speech.scriptNew'),enabled:false}])[0]!
    if(!folder&&current?.type==='folder')update(current.id,tree=>tree.type==='folder'?{...tree,scripts:[...tree.scripts,next as HelperScript]}:tree)
    else setTrees(items=>[...items,next])
    setQuery('');setSection('code');setSelected(id)
  }
  const remove=()=>{
    setTrees(items=>items.filter(tree=>tree.id!==selected).map(tree=>tree.type==='folder'?{...tree,scripts:tree.scripts.filter(script=>script.id!==selected)}:tree))
    setDataTexts(values=>Object.fromEntries(Object.entries(values).filter(([id])=>id!==selected&&!(current?.type==='folder'&&current.scripts.some(script=>script.id===id)))))
    setSelected(peers[position+1]?.id??peers[position-1]?.id??null);setRemoving(false)
  }
  const move=(direction:number)=>{
    const reorder=<T extends {id:string}>(items:T[]):T[]=>{const at=items.findIndex(item=>item.id===selected),to=at+direction;if(at<0||to<0||to>=items.length)return items;const copy=[...items];copy.splice(to,0,copy.splice(at,1)[0]!);return copy}
    setTrees(items=>reorder(items).map(tree=>tree.type==='folder'?{...tree,scripts:reorder(tree.scripts)}:tree))
  }
  const moveToFolder=(folderId:string)=>{
    if(current?.type!=='script')return
    setTrees(items=>{
      if(folderId&&!items.some(tree=>tree.type==='folder'&&tree.id===folderId))return items
      const rest=items.filter(tree=>tree.id!==current.id).map(tree=>tree.type==='folder'?{...tree,scripts:tree.scripts.filter(script=>script.id!==current.id)}:tree)
      return folderId?rest.map(tree=>tree.type==='folder'&&tree.id===folderId?{...tree,scripts:[...tree.scripts,current]}:tree):[...rest,current]
    })
  }
  const save=async()=>{
    if(saving.current)return
    saving.current=true;setBusy(true);setError(null)
    try {
      const trees=materialize()
      const result=target.type==='character'?await props.remote.saveCharacterHelperScripts({cardId:target.cardId,revision,trees}):await props.remote.saveHelperScriptLibrary({target,revision,trees})
      if(!result.ok)throw new Error(result.error.message)
      setTrees(result.value.trees);setRevision(result.value.revision);setBaseline(JSON.stringify(result.value.trees));setDataTexts({})
      notifyHelperScriptAssets(target)
      guard.clearDraft();toast.show(t('speech.scriptSaved'));props.onSaved()
    } catch(error){setError(error instanceof Error?error.message:String(error))}finally{saving.current=false;setBusy(false)}
  }
  const reload=()=>guard.request(()=>{setBusy(true);setError(null);void (target.type==='character'?props.remote.getCharacterHelperScripts({cardId:target.cardId}):props.remote.getHelperScriptLibrary({target})).then(result=>{
    if(!result.ok)throw new Error(result.error.message)
    setTrees(result.value.trees);setRevision(result.value.revision);setBaseline(JSON.stringify(result.value.trees));setDataTexts({});setQuery('');setSelected(result.value.trees[0]?.id??null)
  }).catch(error=>setError(String(error instanceof Error?error.message:error))).finally(()=>setBusy(false))})
  const importFile=async(file:File)=>{
    setBusy(true);setError(null)
    try{
      if(file.size>4*1024*1024)throw new Error(t('speech.scriptFileLarge'))
      const input:unknown=JSON.parse(await file.text())
      const parsed=importHelperScriptFile(input)
      guard.request(()=>{setTrees(parsed);setDataTexts({});setQuery('');setSelected(parsed[0]?.id??null)})
    }catch(error){setError(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
  }
  return <>
    {guard.confirmation}{toast.node}
    <Dialog open title={t(target.type==='global'?'speech.scriptGlobalEditor':target.type==='preset'?'speech.scriptPresetEditor':'speech.scriptEditor')} description={props.label} width="xl" onClose={()=>guard.request(props.onClose)}
      footer={<SaveBar><span className="dsh-tavern-scriptSaveStatus" role="status">{t(busy?'speech.scriptSaving':dirty?'speech.scriptUnsaved':'speech.scriptClean')}</span><Btn size="md" disabled={busy} onClick={()=>guard.request(props.onClose)}>{t('action.close')}</Btn><Btn size="md" primary disabled={busy||!dirty} onClick={()=>void save()}>{t('speech.scriptSaveReload')}</Btn></SaveBar>}>
      <Muted>{t(target.type==='character'?'speech.scriptAssetNote':'speech.scriptLibraryNote')}</Muted><Err message={error}/>
      <div className="dsh-tavern-scriptToolbar">
        <div className="dsh-tavern-scriptTools"><Btn size="md" primary disabled={busy} onClick={()=>add(false)}>{t('speech.scriptAdd')}</Btn><Btn size="md" disabled={busy} onClick={()=>add(true)}>{t('speech.scriptAddFolder')}</Btn></div>
        <div className="dsh-tavern-scriptTools">
          <FileBtn accept=".json,application/json" disabled={busy} onFile={file=>void importFile(file)}>{t('speech.scriptImport')}</FileBtn>
          <Btn size="md" disabled={busy||!trees.length} onClick={()=>{try{downloadJson('tavern-helper-scripts.json',exportHelperScriptTrees(materialize()))}catch(error){setError(String(error))}}}>{t('speech.scriptExport')}</Btn>
          <Btn size="md" disabled={busy} onClick={reload}>{t('speech.scriptReadSaved')}</Btn>
        </div>
      </div>
      <div className="dsh-tavern-scriptEditor" data-empty={!trees.length} aria-busy={busy}>
        <aside className="dsh-tavern-scriptSidebar">
          <div className="dsh-tavern-scriptListHead"><strong>{t('speech.scriptList')}</strong><span className="dsh-tavern-badge">{scriptCount}</span></div>
          <SearchInput label={t('speech.scriptSearch')} placeholder={t('speech.scriptSearch')} value={query} onChange={setQuery} width="100%"/>
          <nav aria-label={t('speech.scriptList')} className="dsh-tavern-scriptTree dsh-tavern-scroll">{visible.map(tree=><div key={tree.id}>
            <div className="dsh-tavern-scriptItem" data-selected={current?.id===tree.id} data-folder={tree.type==='folder'}>
              <Btn disabled={busy} title={tree.name||tree.id} pressed={current?.id===tree.id} onClick={()=>setSelected(tree.id)}>{tree.name||tree.id}</Btn>
              <span className="dsh-tavern-scriptState">{tree.type==='folder'?t('speech.scriptFolderKind'):t(tree.enabled?'speech.scriptOn':'speech.scriptOff')}</span>
            </div>
            {tree.type==='folder'&&tree.scripts.filter(script=>matches(tree)||matches(script)).map(script=><div className="dsh-tavern-scriptItem dsh-tavern-scriptChild" data-selected={current?.id===script.id} key={script.id}>
              <Btn disabled={busy} title={script.name||script.id} pressed={current?.id===script.id} onClick={()=>setSelected(script.id)}>{script.name||script.id}</Btn><span className="dsh-tavern-scriptState">{t(script.enabled&&tree.enabled?'speech.scriptOn':'speech.scriptOff')}</span>
            </div>)}
          </div>)}</nav>
          {!visible.length&&<><Muted>{t(query?'speech.scriptNoResults':'speech.scriptEmptyList')}</Muted>{query&&<Btn onClick={()=>setQuery('')}>{t('action.clearSearch')}</Btn>}</>}
        </aside>
        <div className="dsh-tavern-scriptDetail">{!current&&<div className="dsh-tavern-empty"><div className="dsh-tavern-emptyTitle">{t('speech.scriptEmptyTitle')}</div><div className="dsh-tavern-emptyDesc">{t('speech.scriptEmptyDesc')}</div><Btn primary disabled={busy} onClick={()=>add(false)}>{t('speech.scriptAdd')}</Btn></div>}{current&&<>

          <SettingsRow title={t('speech.scriptName')}><input className="dsh-tavern-input" aria-label={t('speech.scriptName')} value={current.name} disabled={busy} onChange={event=>update(current.id,item=>({...item,name:event.target.value}))}/></SettingsRow>
          <SettingsRow title={t('speech.scriptEnabled')}><Toggle title={t('speech.scriptEnabled')} checked={current.enabled} disabled={busy} onChange={enabled=>update(current.id,item=>({...item,enabled}))}/></SettingsRow>
          <div className="dsh-tavern-scriptTools"><Btn disabled={busy||position<=0} onClick={()=>move(-1)}>{t('speech.scriptUp')}</Btn><Btn disabled={busy||position<0||position>=peers.length-1} onClick={()=>move(1)}>{t('speech.scriptDown')}</Btn><Btn danger disabled={busy} onClick={()=>setRemoving(true)}>{t('speech.scriptRemove')}</Btn></div>
          {current.type==='folder'&&<div className="dsh-tavern-scriptFolderNote"><Muted>{t('speech.scriptFolderDesc')}</Muted><Btn disabled={busy} onClick={()=>add(false)}>{t('speech.scriptAdd')}</Btn></div>}
          {current.type==='script'&&<>
            {siblings?.type==='folder'&&!siblings.enabled&&<Muted>{t('speech.scriptParentDisabled')}</Muted>}
            <SettingsRow title={t('speech.scriptFolder')}><Select title={t('speech.scriptFolder')} disabled={busy} value={trees.find(tree=>tree.type==='folder'&&tree.scripts.some(script=>script.id===current.id))?.id??''}
              options={[{value:'',label:t('speech.scriptRoot')},...trees.filter(tree=>tree.type==='folder').map(tree=>({value:tree.id,label:tree.name||tree.id}))]} onChange={moveToFolder}/></SettingsRow>
            <Tabs id={tabsId} panelId={tabsId+'-panel'} label={t('speech.scriptSections')} value={section} onChange={setSection} items={[{id:'code',label:t('speech.scriptTabCode')},{id:'data',label:t('speech.scriptTabData')},{id:'buttons',label:t('speech.scriptTabButtons')}]}/>
            <div id={tabsId+'-panel'} role="tabpanel" aria-labelledby={tabsId+'-'+section} tabIndex={0}>
            <div hidden={section!=='code'}>
            <SettingsRow stacked title={t('speech.scriptCode')}><textarea className="dsh-tavern-input dsh-tavern-scriptCode" aria-label={t('speech.scriptCode')} value={current.content} disabled={busy} spellCheck={false} onChange={event=>update(current.id,item=>({...item,content:event.target.value}))}/></SettingsRow>
            <details><summary>{t('speech.scriptInfo')}</summary><SettingsRow stacked title={t('speech.scriptInfo')}><textarea className="dsh-tavern-input" aria-label={t('speech.scriptInfo')} value={current.info} disabled={busy} onChange={event=>update(current.id,item=>({...item,info:event.target.value}))}/></SettingsRow></details>
            </div><div hidden={section!=='data'}>
            <SettingsRow stacked title={t('speech.scriptData')}><textarea className="dsh-tavern-input" aria-label={t('speech.scriptData')} value={dataTexts[current.id]??JSON.stringify(current.data,null,2)} disabled={busy} spellCheck={false} onChange={event=>setDataTexts(values=>({...values,[current.id]:event.target.value}))}/></SettingsRow>
            <Btn disabled={busy} onClick={()=>{try{const data=scriptData(current).data;setDataTexts(values=>({...values,[current.id]:JSON.stringify(data,null,2)}));setError(null)}catch(error){setError(error instanceof Error?error.message:String(error))}}}>{t('speech.scriptFormatData')}</Btn>
            <SettingsRow title={t('speech.scriptExportData')}><Toggle title={t('speech.scriptExportData')} checked={current.export_with.data} disabled={busy} onChange={data=>update(current.id,item=>({...item,export_with:{...current.export_with,data}}))}/></SettingsRow>

            </div><div hidden={section!=='buttons'}>
            <SettingsRow title={t('speech.scriptExportButtons')}><Toggle title={t('speech.scriptExportButtons')} checked={current.export_with.button} disabled={busy} onChange={button=>update(current.id,item=>({...item,export_with:{...current.export_with,button}}))}/></SettingsRow>
            <SettingsRow title={t('speech.scriptButtons')}><Toggle title={t('speech.scriptButtons')} checked={current.button.enabled} disabled={busy} onChange={enabled=>update(current.id,item=>({...item,button:{...current.button,enabled}}))}/></SettingsRow>
            {current.button.buttons.map((button,index)=><div className="dsh-tavern-scriptTools" key={index}>
              <input className="dsh-tavern-input" aria-label={t('speech.scriptButtonName')} value={button.name} disabled={busy} onChange={event=>update(current.id,item=>({...item,button:{...current.button,buttons:current.button.buttons.map((old,i)=>i===index?{...old,name:event.target.value}:old)}}))}/>
              <Toggle title={`${t('speech.scriptButtonVisible')}: ${button.name}`} checked={button.visible} disabled={busy} onChange={visible=>update(current.id,item=>({...item,button:{...current.button,buttons:current.button.buttons.map((old,i)=>i===index?{...old,visible}:old)}}))}/>
              <Btn disabled={busy} onClick={()=>update(current.id,item=>({...item,button:{...current.button,buttons:current.button.buttons.filter((_,i)=>i!==index)}}))}>{t('speech.scriptRemove')}</Btn>
            </div>)}
            <Btn disabled={busy} onClick={()=>update(current.id,item=>({...item,button:{...current.button,buttons:[...current.button.buttons,{name:'',visible:true}]}}))}>{t('speech.scriptAddButton')}</Btn>
            </div></div>
          </>}
        </>}</div>
      </div>
    </Dialog>
    <ConfirmDialog open={removing} title={t('speech.scriptRemove')} description={t('speech.scriptRemoveNote')} danger busy={busy} onCancel={()=>setRemoving(false)} onConfirm={remove}/>
  </>
}
