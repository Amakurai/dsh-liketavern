/** 模板上下文兼容：只从冻结文本历史与当前消息元数据派生索引，绝不读取宿主或兄弟剧情。 */
export const TEMPLATE_CONTEXT = String.raw`
function refreshTemplateContext() {
  Object.assign(api,{
    char:input.char,user:input.user,charName:input.char,userName:input.user,assistantName:input.char,
    model:input.model ?? '',groupId:null,groups:[],
    charAvatar:input.charAvatar ?? '',userAvatar:input.userAvatar ?? '',
    chatId:input.sessionId,characterId:input.cardId,
    generateType:input.phase==='generate' ? input.generationType || 'normal' : '',
    lastUserMessageId:input.history.findLastIndex(message=>message.role==='user'),
    lastCharMessageId:input.history.findLastIndex(message=>message.role==='assistant'),
    lastMessageId:input.history.length-1,
    lastUserMessage:input.history.findLast(message=>message.role==='user')?.content ?? '',
    lastCharMessage:input.history.findLast(message=>message.role==='assistant')?.content ?? '',
  });
  setTemplateMessageContext(null);
}
Object.defineProperty(api,'isDryRun',{configurable:true,enumerable:true,get:()=>preparing});
function setTemplateMessageContext(metadata) {
  if(metadata==null) {
    for(const key of ['name','message_id','swipe_id','is_last','is_user','is_system','hostMessageId']) api[key]=undefined;
    return {role:'assistant',worldinfo:false,depth:0};
  }
  if(!metadata || typeof metadata!=='object' || Array.isArray(metadata)
    || !Number.isSafeInteger(metadata.index) || metadata.index<0 || metadata.index>=input.history.length
    || !['user','assistant','system'].includes(metadata.role)
    || input.history[metadata.index].role!==metadata.role
    || !Number.isSafeInteger(metadata.swipeId) || metadata.swipeId<0
    || metadata.name!=null && typeof metadata.name!=='string'
    || metadata.hostMessageId!=null && (!Number.isSafeInteger(metadata.hostMessageId) || metadata.hostMessageId<0)) {
    throw Error('模板消息上下文无效');
  }
  const message=input.history[metadata.index];
  selectCurrentMessage(metadata.index);
  Object.assign(api,{
    name:metadata.name ?? message.name ?? (metadata.role==='assistant' ? input.char : metadata.role==='user' ? input.user : ''),
    message_id:metadata.index,
    swipe_id:metadata.swipeId,
    is_last:metadata.index===input.history.length-1,
    is_user:metadata.role==='user',
    is_system:metadata.role==='system',
    hostMessageId:metadata.hostMessageId,
  });
  return {role:metadata.role,worldinfo:false,depth:input.history.length-metadata.index-1};
}
globalThis.__setTemplateMessageContext=setTemplateMessageContext;
globalThis.__refreshTemplateContext=refreshTemplateContext;
refreshTemplateContext();
`;
