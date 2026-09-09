/** 酒馆助手卡面兼容：同步消息快照、窄开场白操作、宏与错误提示；不提供宿主通用 RPC。 */
import type { HelperSnapshot } from './helperRuntime.js'
export interface CardHelperContext {
  snapshot?: HelperSnapshot
  message?: string
  /** 当前卡面的宿主消息 seq；独立开场白/预览为 0，不冒充完整 ST 聊天序号。 */
  messageId?: number
  name?: string
  userName?: string
  frameIndex?: number
  canSwipe?: boolean
  scriptFrame?:boolean
}
export interface CardHelperLabels {
  diagnostics: string
  unsupported: string
}

/** 自包含函数注入 opaque-origin iframe；返回清理器供 document.write 重装使用。 */
export function installCardHelper(
  context: CardHelperContext,
  greetings: string[],
  greetingIndex: number,
  source: string,
  labels: CardHelperLabels,
): () => void {
  type Table = Record<string, unknown>
  const root = window as unknown as Table
  const getSnapshot=()=>root.__dshTavernSnapshot as HelperSnapshot|undefined ?? context.snapshot
  const currentId=()=>getSnapshot()?.currentMessageId??context.messageId??0
  const latestId=()=>getSnapshot()?getSnapshot()!.messages.length-1:currentId()
  const frameIndex = context.frameIndex ?? 0
  const name = context.name ?? ''
  const user = context.userName ?? ''
  const text = context.message ?? greetings[greetingIndex] ?? greetings[0] ?? ''
  const canSwipe = context.canSwipe ?? (context.message === undefined && greetings.length > 0)
  const iframeName = `TH-message--${currentId()}--${frameIndex}`
  if(context.scriptFrame)delete root.__dshTavernScriptFailure
  const errors: string[] = []
  let active = true
  const variables = root.getVariables as (option?: unknown) => Table
  const emit = root.eventEmit as (event: string, ...args: unknown[]) => Promise<void>
  function record(value: unknown): value is Table { return value !== null && typeof value === 'object' && !Array.isArray(value) }
  function showError(error: unknown, fatal=false) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 2000)
    if(active&&context.scriptFrame&&fatal&&root.__dshTavernScriptFailure!==message){
      root.__dshTavernScriptFailure=message
      parent.postMessage({source,action:'helperScriptDiagnostic',runtimeId:root.__dshTavernEventRuntimeId,error:message},'*')
    }
    if (errors.includes(message)) return
    errors.push(message)
    if (errors.length > 8) errors.shift()
    mountErrors()
  }
  function mountErrors() {
    if (!active || !errors.length || !document.body) return
    let box = document.getElementById('dsh-tavern-helper-errors')
    if (!box) {
      box = document.createElement('details')
      box.id = 'dsh-tavern-helper-errors'
      box.setAttribute('open', '')
      const title = document.createElement('summary')
      title.textContent = labels.diagnostics
      box.append(title, document.createElement('pre'))
      document.body.prepend(box)
    }
    const content = box.querySelector('pre')
    if (content) content.textContent = errors.join('\n')
  }
  function unsupported(api: string): never {
    const error = new Error(`${labels.unsupported}: ${api}`)
    showError(error)
    throw error
  }
  function getCurrentMessageId() { return currentId() }
  function getLastMessageId() { return latestId() }
  function getIframeName() { return `TH-message--${currentId()}--${frameIndex}` }
  function getMessageId(value: string) {
    const match = /^TH-message--(\d+)--\d+$/.exec(value)
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('Invalid message iframe name')
    return Number(match[1])
  }
  function substitudeMacros(value: string) {
    if (typeof value !== 'string') throw new Error('Macro input must be text')
    return value.replace(/\{\{(char|user|lastMessageId|currentMessageId)\}\}/gi, (match, key: string) => {
      switch (key.toLowerCase()) {
        case 'char': return name
        case 'user': return user
        case 'lastmessageid': return String(latestId())
        case 'currentmessageid': return String(currentId())
        default: return match
      }
    })
  }
  function selected(range: string | number = currentId(), index=currentId()) {
    const lastId=latestId()
    if (typeof range === 'number') return Number.isSafeInteger(range) && (range < 0 ? lastId+range+1 : range) === index
    if (typeof range !== 'string') throw new Error('Invalid message range')
    const match = /^(-?\d+)(?:-(-?\d+))?$/.exec(substitudeMacros(range).trim())
    if (!match) throw new Error('Invalid message range')
    const first = Number(match[1]), last = Number(match[2] ?? match[1])
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) throw new Error('Invalid message range')
    const from = first < 0 ? lastId + first + 1 : first
    const to = last < 0 ? lastId + last + 1 : last
    return from <= index && index <= to
  }
  function getChatMessages(range: string | number = currentId(), option: { role?: string; hide_state?: string; include_swipes?: boolean } = {}) {
    const id=currentId(), snapshot=getSnapshot()
    if(snapshot) {
      return snapshot.messages.filter(message=>selected(range,message.message_id)
        && (!option.role||option.role==='all'||option.role===message.role)
        && (!option.hide_state||option.hide_state==='all'||(option.hide_state==='hidden')===message.is_hidden))
        .map(message=>{
          const current=message.swipe?.active??(canSwipe&&message.message_id===id?greetingIndex:0)
          const swipes=message.swipe?message.swipe.pages.map(page=>page.message):canSwipe&&message.message_id===id?greetings.slice():[message.message]
          swipes[current]=message.message
          const data=variables({type:'message',message_id:message.message_id}),extra=JSON.parse(JSON.stringify(message.extra))
          const {swipe:_swipe,...visible}=message
          return {...visible,data,extra,
            mes:message.message,is_user:message.role==='user',is_system:message.role==='system',swipe_id:current,
            swipes,...(option.include_swipes?{swipes_data:swipes.map((_,index)=>JSON.parse(JSON.stringify(index===current?data:message.swipe?.pages[index]?.data??{}))),swipes_info:swipes.map((_,index)=>JSON.parse(JSON.stringify(index===current?extra:message.swipe?.pages[index]?.extra??{})))}:{})}
        })
    }
    if (!selected(range) || (option.role && !['all', 'assistant'].includes(option.role)) || option.hide_state === 'hidden') return []
    const swipes = canSwipe ? greetings.slice() : [text]
    const data = variables({ type: 'message', message_id: id })
    return [{ message_id: id, name, role: 'assistant', is_hidden: false, message: text, data, extra: {},
      // 旧封面依赖这些 ST 原生字段；现代调用也能读取正常的 message/data。
      mes: text, is_user: false, is_system: false, swipe_id: canSwipe ? greetingIndex : 0,
      swipes, ...(option.include_swipes ? { swipes_data: swipes.map((_,index) => index===(canSwipe?greetingIndex:0)?JSON.parse(JSON.stringify(data)):{}), swipes_info: swipes.map(() => ({})) } : {}),
    }]
  }
  function swipe(index: number) {
    if (!active) throw new Error('Card helper runtime has been disposed')
    if (!canSwipe) return unsupported('swipeGreeting (preview or conversation already started)')
    if (!Number.isSafeInteger(index) || index < 0 || index >= greetings.length) throw new Error('Greeting index out of range')
    parent.postMessage({ source, action: 'swipeGreeting', index }, '*')
  }
  async function setChatMessages(messages: unknown) {
    // 整批验证后只发一次请求，拒绝半执行或把正文修改悄悄解释成 swipe。
    if (!Array.isArray(messages) || messages.length !== 1) return unsupported('setChatMessages (only one greeting swipe is supported)')
    const message: unknown = messages[0]
    if (!record(message) || !Object.hasOwn(message, 'message_id') || !selected(message.message_id as number) || !Object.hasOwn(message, 'swipe_id')
      || Object.keys(message).some(key => !['message_id', 'swipe_id'].includes(key))) return unsupported('setChatMessages (only greeting swipe_id is supported)')
    swipe(message.swipe_id as number)
  }
  async function setChatMessage(field: unknown, messageId: number, option?: { swipe_id?: number }) {
    if ((field !== '' && field !== null && field !== undefined) || option?.swipe_id === undefined) return unsupported('setChatMessage (only greeting swipe_id is supported)')
    return setChatMessages([{ message_id: messageId, swipe_id: option.swipe_id }])
  }
  async function triggerSlash(command: string) {
    if (typeof command !== 'string') throw new Error('Slash command must be text')
    const match = /^\/swipe(?:\s+(\d+|left|right))?\s*$/i.exec(command.trim())
    if (match) {
      const value = match[1]?.toLowerCase()
      const index = value === 'left' ? greetingIndex - 1 : !value || value === 'right' ? greetingIndex + 1 : Number(value)
      swipe(value && /^\d+$/.test(value) ? index : (index + greetings.length) % greetings.length)
      return ''
    }
    const pass = /^\/pass(?:\s+([\s\S]*))?$/.exec(command.trim())
    if (pass) return substitudeMacros(pass[1] ?? '')
    return unsupported(`triggerSlash ${command.split(/\s/)[0]}`)
  }
  function errorCatched<T extends unknown[], U>(fn: (...args: T) => U): (...args: T) => U {
    return function (this: unknown, ...args: T): U {
      try {
        const value = fn.apply(this, args)
        if (value && typeof (value as unknown as { then?: unknown }).then === 'function') return Promise.resolve(value).catch(error => { showError(error); throw error }) as U
        return value
      } catch (error) { showError(error); throw error }
    }
  }
  const api: Table = { getCurrentMessageId, getLastMessageId, getIframeName, getMessageId, substitudeMacros,
    getChatMessages, setChatMessages, setChatMessage, triggerSlash, errorCatched,
    getTavernHelperVersion: () => '0.1.0-dsh-card',
    getScriptId: () => unsupported('getScriptId (this is a message iframe)'),
    reloadIframe: () => unsupported('reloadIframe (use the host card restore control)'),
  }
  for (const key of ['generate', 'generateRaw', 'injectPrompts', 'uninjectPrompts', 'createChatMessages', 'deleteChatMessages',
    'rotateChatMessages', 'getWorldbook', 'replaceWorldbook', 'updateWorldbookWith', 'getWorldbookNames', 'createWorldbook', 'deleteWorldbook',
    'getLorebookEntries', 'setLorebookEntries', 'getLorebooks', 'getTavernRegexes', 'replaceTavernRegexes', 'getScriptTrees',
    'replaceScriptTrees', 'getPreset', 'replacePreset', 'getCharacter', 'getCharWorldbookNames', 'getChatWorldbookName']) {
    api[key] = () => unsupported(key)
  }
  Object.assign(root, api)
  root.TavernHelper = Object.assign(root.TavernHelper ?? {}, api)
  let chat: ReturnType<typeof getChatMessages> | undefined
  let originalChat = ''
  const chatContent = (value: ReturnType<typeof getChatMessages>) => JSON.stringify(value.map(({ swipe_id: _swipe, ...message }) => message))
  let chatGeneration:unknown
  function contextChat() {
    if (!chat || chatGeneration!==root.__dshTavernSnapshotGeneration) { chatGeneration=root.__dshTavernSnapshotGeneration; chat = getChatMessages(getSnapshot() ? `0-${latestId()}` : currentId()); originalChat = chatContent(chat) }
    return chat
  }
  root.SillyTavern = { getContext: () => ({ chat: contextChat(),
    name1: user, name2: name,
    swipe: () => swipe((greetingIndex + 1) % greetings.length),
    saveChat: async () => {
      if (!chat || chatContent(chat) !== originalChat) return unsupported('saveChat (only greeting swipe_id is supported)')
      await setChatMessages([{ message_id: currentId(), swipe_id: chat.find(message=>message.message_id===currentId())?.swipe_id }])
    },
    eventSource: { on: root.eventOn, once: root.eventOnce, emit: root.eventEmit, removeListener: root.eventRemoveListener },
    event_types: root.tavern_events,
  }) }
  root.toastr = { info: (value:unknown)=>showError(value), success: (value:unknown)=>showError(value), warning: (value:unknown)=>showError(value), error: (value:unknown)=>showError(value) }
  root.__dshTavernReportError=(error:unknown)=>showError(error,true)
  const onError = (event: ErrorEvent) => showError(event.error ?? event.message,true)
  // 旧状态面板读取 window.chat；仅返回当前沙箱的同步快照副本，绝不回退父窗口。
  const chatSnapshot=()=>getChatMessages('0-{{lastMessageId}}')
  Object.defineProperty(root,'chat',{configurable:true,get:chatSnapshot})
  const onRejection = (event: PromiseRejectionEvent) => showError(event.reason,true)
  async function ready() {
    mountErrors()
    if (!active) return
    if(context.scriptFrame)return
    try{
      await emit('message_iframe_render_started', iframeName)
      if (active) await emit('message_iframe_render_ended', iframeName)
    }finally{
      if(active&&getSnapshot())parent.postMessage({source,action:'helperFrameReady',runtimeId:root.__dshTavernEventRuntimeId},'*')
    }
  }
  const onReady = () => { void ready().catch(showError) }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true })
  else queueMicrotask(onReady)
  return () => {
    active = false
    if(Object.getOwnPropertyDescriptor(root,'chat')?.get===chatSnapshot)delete root.chat
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    document.removeEventListener('DOMContentLoaded', onReady)
  }
}
