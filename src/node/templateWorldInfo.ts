/** 沙箱内的世界书 API：只访问冻结的绑定资产，主动激活作为数据交给同轮 WI 引擎处理。 */
export const TEMPLATE_WORLD_INFO = String.raw`
const activations = new Map();
const entryData = entry => ({...clone(entry), key:clone(entry.keys), keysecondary:clone(entry.secondaryKeys),
  disable:!entry.enabled, world:entry.sourceRef, vectorized:false, _tavernKey:entry.key});
function findEntry(book,title) {
  return findTemplateEntry(book,title);
}
async function activewi(book,title,force=false) {
  if (typeof title==='boolean' || title===undefined) {force=title ?? false; title=book; book='';}
  if (input.phase!=='generate') throw Error('activewi 只能在生成阶段调用');
  const entry = findEntry(book,title);
  if (!entry || entry.templateDontActivate || entry.templateOnlyPreload) return null;
  if (!force && !entry.enabled) return null;
  if (/^\[(?:InitialVariables|RENDER)\b/i.test(entry.comment)) return null;
  if (entry.templateCondition && !(await templateCondition(entry.templateCondition))) return null;
  activations.set(entry.key,Boolean(force) || activations.get(entry.key) || false);
  return entryData(entry);
}
async function templateCondition(expression) {
  const before = __conditionState();
  const result = await evalTemplate('<%- Boolean('+expression+') %>');
  if (__conditionState()!==before) throw Error('@@if 条件必须只读，不能修改变量');
  return result==='true';
}
function keywordMatch(pattern,text,sensitive=false,whole=false) {
  const literal = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(pattern);
  if (literal) return new RegExp(literal[1],literal[2]).test(text);
  if (!sensitive) {pattern=pattern.toLowerCase();text=text.toLowerCase();}
  if (!whole) return text.includes(pattern);
  let at=-1;
  while((at=text.indexOf(pattern,at+1))!==-1) {
    const word = c=>c!==undefined && /[\p{L}\p{N}_]/u.test(c);
    if (!word(text[at-1]) && !word(text[at+pattern.length])) return true;
  }
  return false;
}
function selectActivatedEntries(entries,keywords,condition={}) {
  const text=(Array.isArray(keywords)?keywords:[keywords]).join('\n');
  return entries.filter(e=> {
    const disabled=e.disable ?? !e.enabled;
    for (const [key,value] of Object.entries(condition)) {
      if (!['constant','disabled','vectorized'].includes(key)) throw Error('未知世界书筛选条件：'+key);
      if (value!=null && Boolean(key==='disabled'?disabled:e[key])!==value) return false;
    }
    if (condition.disabled==null && disabled) return false;
    if (e.templateDontActivate) return false;
    if (e.constant) return true;
    const keys=Array.isArray(e.key)?e.key:e.keys || [];
    const secondary=e.keysecondary || e.secondaryKeys || [];
    const test=k=>keywordMatch(String(k),text,e.caseSensitive ?? false,e.matchWholeWords ?? false);
    if (!keys.some(test)) return false;
    if (!e.selective || !secondary.length) return true;
    const count=secondary.filter(test).length;
    return [count>0,count<secondary.length,count===0,count===secondary.length][e.selectiveLogic || 0];
  });
}
async function activateWorldInfoByKeywords(keywords,condition={}) {
  const results=[];
  for (const entry of selectActivatedEntries(input.entries.map(entryData),keywords,condition)) {
    const result=await activewi(entry.world,entry.uid,condition.disabled===true);
    if (result) results.push(result);
  }
  return results;
}
Object.assign(api,{activewi,activateWorldInfo:activewi,selectActivatedEntries,activateWorldInfoByKeywords,
  getWorldInfoData:async name=>input.entries.filter(e=>!name||matches(e.sourceRef,name)).map(entryData),
  getEnabledWorldInfoEntries:async (chara=true,global=true,persona=true,charaExtra=true)=>input.entries
    .filter(e=>e.source==='character'?(chara||charaExtra):e.source==='global'?global:e.source==='persona'?persona:e.source!=='delta').map(entryData),
  getWorldInfoActivatedData:async (name,keywords,condition={})=>selectActivatedEntries(input.entries.filter(e=>!name||matches(e.sourceRef,name)).map(entryData),keywords,condition),
});
globalThis.__activationRequests=()=>JSON.stringify([...activations].map(([key,force])=>({key,force})));
`;
