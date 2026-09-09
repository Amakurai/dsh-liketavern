/** 脚本只能提交有界文本选项；可信按钮经宿主公开草稿接口填入，第三方代码不接触主页面。 */
import {useState,useSyncExternalStore} from 'react'
import type {SessionInput} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {HelperSnapshot} from '../core/helperRuntime.js'
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
export function ScriptChoices({sessionId,context}:{sessionId:string;context:HelperSnapshot}) {
  const t=useT(),all=useSyncExternalStore(subscribe,snapshot,snapshot),[error,setError]=useState<string|null>(null),[previous,setPrevious]=useState('')
  const choices=all.filter(entry=>entry.sessionId===sessionId&&entry.storyId===context.storyId&&entry.historyRevision===context.historyRevision&&entry.messageId===context.currentMessageId).flatMap(entry=>entry.choices)
  if(!choices.length)return null
  return <div className="dsh-tavern-messageChoices" aria-label={t('speech.scriptChoices')}><div>{choices.map((choice,index)=><Btn key={index} title={choice.text} onClick={()=>{try{const input=inputFor?.(sessionId);if(!input)throw new Error(t('speech.choiceUnavailable'));const state=input.state.getSnapshot();if(state.phase!=='plain'||state.occurrences.length)throw new Error(t('speech.choiceBusy'));input.setDraft(choiceDraft(state.draft,choice.text,previous));setPrevious(choice.text);setError(null)}catch(value){setError(value instanceof Error?value.message:String(value))}}}>{choice.label}</Btn>)}</div><Err message={error}/></div>
}
