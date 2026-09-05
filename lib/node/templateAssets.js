/** 沙箱内资产读取适配：默认主世界书、嵌套条目来源与完整角色定义共用冻结资产。 */
export const TEMPLATE_ASSETS = String.raw `
const assetIdentity=(text,charName=input.char)=>String(text).replace(/\{\{(char|user)\}\}/gi,(_,name)=>name.toLowerCase()==='char'?charName:input.user);
function assetLocals(parent,data) {
  const inherited={};
  if(parent && typeof parent==='object') for(const key of Object.keys(parent)) {
    if(!Object.hasOwn(api.defines,key)) inherited[key]=parent[key];
  }
  return {...inherited,...data};
}
function findTemplateEntry(book,title) {
  const selected=book || input.entries.find(entry=>entry.source==='character')?.sourceRef;
  if(!selected) return undefined;
  return input.entries.find(entry=>matches(entry.sourceRef,selected) && (matches(entry.uid,title)||matches(entry.comment,title)));
}
globalThis.__sourceData=(source,data)=> {
  const entry=input.entries.find(value=>value.key===source);
  return entry ? {...data,world_info:entryData(entry)} : data;
};
async function getwi(book,title,data={}) {
  if(title===undefined || title && typeof title==='object' && !(title instanceof RegExp)) {
    data=title || {};title=book;book='';
  }
  const entry=findTemplateEntry(book || this?.world_info?.world,title);
  if(!entry) return '';
  return assetIdentity(await evalTemplate(entry.content,{...assetLocals(this,data),world_info:entryData(entry)}));
}
function currentCharacter(name) {
  return name===undefined || name===null || name==='' || matches(input.char,name) || input.cardId!==undefined && matches(input.cardId,name);
}
function getCharacterData(name) {return currentCharacter(name) ? clone(input.card) : null;}
async function getCharacterDefinition(name,template,data={}) {
  const card=getCharacterData(name);
  if(!card) return '';
  const details=card.data || card;
  const example=String(card.mes_example || details.mes_example || '').trim().split(/<START>/i).map(part=>part.trim()).filter(Boolean);
  const fields={name:card.name || input.char,description:card.description || '',personality:card.personality || '',scenario:card.scenario || '',
    first_message:card.first_mes || '',message_example:example.length>1?example.map(part=>'\x60\x60\x60\n'+part+'\n\x60\x60\x60').join('\n'):example[0] || '',
    creator_notes:details.creator_notes || '',creatorcomment:card.creatorcomment || '',system_prompt:details.system_prompt || '',
    post_history_instructions:details.post_history_instructions || '',alternate_greetings:details.alternate_greetings || [],
    depth_prompt:details.depth_prompt?.prompt ?? details.depth_prompt ?? details.extensions?.depth_prompt?.prompt ?? '',creator:details.creator || ''};
  if(template===undefined) {
    const parts=['<<%- name %>>'];
    for(const [key,label] of [['system_prompt','System'],['name','name'],['personality','personality'],['description','description'],['message_example','example'],['depth_prompt','System']]) {
      if(fields[key]) parts.push(label+':'+(key==='message_example'?'\n':' ')+'<%- '+key+' %>');
    }
    parts.push('</<%- name %>>');template=parts.join('\n');
  }
  return assetIdentity(await evalTemplate(String(template),{...assetLocals(this,data),...fields,chara_name:fields.name}),fields.name);
}
`;
