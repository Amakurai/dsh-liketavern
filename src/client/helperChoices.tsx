/** 脚本只能提交有界文本选项；可信按钮经宿主公开草稿接口填入，第三方代码不接触主页面。 */
import {useRef,useState,useSyncExternalStore} from 'react'
import type {SessionInput} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {HelperDisplayContext,HelperSnapshot} from '../core/helperRuntime.js'
import {Btn,Err} from './util.js'
import {useT} from './i18n.js'
export interface ScriptChoice {label:string;text:string}
interface Entry {owner:symbol;sessionId:string;storyId:string;historyRevision:string;messageId:number;choices:ScriptChoice[]}
let entries:readonly Entry[]=[]
const listeners=new Set<()=>void>()
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}
const snapshot=()=>entries
const notify=()=>{for(const listener of listeners)listener()}
let inputFor:((sessionId:string)=>SessionInput|undefined)|undefined
export function installChoiceInput(resolve:(sessionId:string)=>SessionInput|undefined):()=>void {inputFor=resolve;return()=>{if(inputFor===resolve)inputFor=undefined}}
export function parseScriptChoices(value:unknown):ScriptChoice[] {
  if(!Array.isArray(value)||value.length>32)throw new Error('选项需为至多 32 项的数组')
  return value.map(item=>{if(!item||typeof item!=='object'||typeof item.label!=='string'||!item.label.trim()||item.label.length>128||typeof item.text!=='string'||!item.text.trim()||item.text.length>1024||Object.keys(item).some(key=>!['label','text'].includes(key)))throw new Error('选项文本无效或超出预算');return {label:item.label,text:item.text}})
}
export function publishScriptChoices(owner:symbol,sessionId:string,context:HelperSnapshot,messageId:number,choices:unknown):void {
  if(!Number.isSafeInteger(messageId)||!context.messages.some(message=>message.message_id===messageId&&message.role==='assistant'&&!message.is_hidden))throw new Error('选项目标消息无效')
  const parsed=parseScriptChoices(choices)
  entries=[...entries.filter(entry=>entry.owner!==owner),{owner,sessionId,storyId:context.storyId,historyRevision:context.historyRevision,messageId,choices:parsed}];notify()
}
export function clearScriptChoices(owner:symbol):void {if(!entries.some(entry=>entry.owner===owner))return;entries=entries.filter(entry=>entry.owner!==owner);notify()}
export function choiceDraft(draft:string,text:string,previous:string):string {return previous&&draft.endsWith(previous)?draft.slice(0,-previous.length)+text:draft+(draft&&!draft.endsWith('\n')?'\n':'')+text}
type ScriptChoiceContext=Pick<HelperDisplayContext,'storyId'|'historyRevision'|'currentMessageId'>
interface ScriptChoicesProps {sessionId:string;context:ScriptChoiceContext}
export function ScriptChoices(props:ScriptChoicesProps) {
  const {sessionId,context}=props
  return <ScriptChoicesMessage key={JSON.stringify([sessionId,context.storyId,context.historyRevision,context.currentMessageId])} {...props}/>
}
function ScriptChoicesMessage({sessionId,context}:ScriptChoicesProps) {
  const t=useT(),all=useSyncExternalStore(subscribe,snapshot,snapshot),[error,setError]=useState<string|null>(null)
  const previous=useRef<{draft:string;revision:number;text:string}|null>(null)
  const choices=all.filter(entry=>entry.sessionId===sessionId&&entry.storyId===context.storyId&&entry.historyRevision===context.historyRevision&&entry.messageId===context.currentMessageId).flatMap(entry=>entry.choices)
  if(!choices.length)return null
  const pick=(choice:ScriptChoice)=>{
    try {
      const input=inputFor?.(sessionId)
      if(!input)throw new Error(t('speech.choiceUnavailable'))
      const state=input.state.getSnapshot()
      if(state.phase!=='plain'||state.occurrences.length)throw new Error(t('speech.choiceBusy'))
      // 宿主 draftRev 可区分手动改回同文；只替换本消息上次写入且从未被编辑的完整结果。
      const last=previous.current
      const replace=last&&last.draft===state.draft&&last.revision===state.draftRev
      input.setDraft(choiceDraft(state.draft,choice.text,replace?last.text:''))
      const written=input.state.getSnapshot()
      previous.current={draft:written.draft,revision:written.draftRev,text:choice.text}
      setError(null)
    } catch(value) {setError(value instanceof Error?value.message:String(value))}
  }
  return <div className="dsh-tavern-messageChoices" aria-label={t('speech.scriptChoices')}><div>{choices.map((choice,index)=><Btn key={index} title={choice.text} onClick={()=>pick(choice)}>{choice.label}</Btn>)}</div><Err message={error}/></div>
}
