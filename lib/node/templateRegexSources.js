export const TEMPLATE_REGEX_SOURCES = String.raw `
const templateRegexMatchCache=new Map();
let templateRegexCacheChars=0;
function resetTemplateRegexSources() {templateRegexMatchCache.clear();templateRegexCacheChars=0;}
globalThis.__applyTemporaryRegexSources=(inputParts,stage,meta,namespace)=> {
  if(typeof namespace!=='string' || namespace.length>4096) throw Error('正则来源命名空间无效或超限');
  const validate=parts=> {
    if(!Array.isArray(parts)||parts.length>4096) throw Error('正则来源超过 4096 段上限');
    let size=0;
    for(const part of parts) {
      if(!part || typeof part!=='object' || Array.isArray(part) || typeof part.key!=='string' || part.key.length>4096
        || typeof part.text!=='string' || !Number.isSafeInteger(part.start) || part.start<0) throw Error('正则来源区间无效');
      size+=part.text.length;
    }
    if(size>1024*1024) throw Error('正则来源正文超过 1 MiB 上限');
  };
  validate(inputParts);
  let parts=inputParts.map(part=>({...part})),matches=0,work=0;
  for(const rule of templateRegexRulesForStage(stage,meta)) {
    const text=parts.map(part=>part.text).join('');
    const offsets=[];
    let total=0;
    for(const part of parts) {offsets.push(total);total+=part.text.length;}
    const at=position=> {
      for(let index=0;index<parts.length;index++) {
        if(++work>1000000) throw Error('正则来源映射工作量超过上限');
        const part=parts[index],start=offsets[index];
        if(position<start+part.text.length || index===parts.length-1) return {key:part.key,start:part.start+Math.min(part.text.length,Math.max(0,position-start))};
      }
      return {key:'empty:'+namespace,start:0};
    };
    const slice=(start,end)=> {
      const output=[];
      for(let index=0;index<parts.length;index++) {
        if(++work>1000000) throw Error('正则来源映射工作量超过上限');
        const part=parts[index],begin=offsets[index],finish=begin+part.text.length;
        if(finish<=start || begin>=end) continue;
        const left=Math.max(start,begin),right=Math.min(end,finish);
        output.push({key:part.key,text:part.text.slice(left-begin,right-begin),start:part.start+left-begin});
      }
      return output;
    };
    const substitution=(replacement,args,offset,groups)=>replacement.replace(/\$([$&'\x60]|[0-9]{1,2}|<[^>]*>)/g,(token,key)=> {
      if(key==='$') return '$';
      if(key==='&') return args[0];
      if(key==='\x60') return text.slice(0,offset);
      if(key==="'") return text.slice(offset+args[0].length);
      if(key[0]==='<') return groups===undefined?token:String(groups[key.slice(1,-1)] ?? '');
      const count=args.length-1,number=Number(key);
      if(number>0 && number<=count) return String(args[number] ?? '');
      if(key.length===2 && Number(key[0])>0 && Number(key[0])<=count) return String(args[Number(key[0])] ?? '')+key[1];
      return token;
    });
    const result=[];let cursor=0,resultChars=0;
    const append=part=> {
      if(!part.text) return;
      resultChars+=part.text.length;
      if(resultChars>1024*1024) throw Error('临时正则输出超过 1 MiB 上限');
      const last=result[result.length-1];
      if(last && last.key===part.key && last.start+last.text.length===part.start) last.text+=part.text;
      else result.push(part);
      if(result.length>4096) throw Error('正则结果超过 4096 段上限');
    };
    const expression=new RegExp(rule.expression.source,rule.expression.flags);
    text.replace(expression,(...args)=> {
      if(++matches>4096) throw Error('正则来源匹配超过 4096 次上限');
      const groups=typeof args[args.length-1]==='object'?args[args.length-1]:undefined;
      const offset=args[args.length-(groups===undefined?2:3)];
      const captures=args.slice(0,args.length-(groups===undefined?2:3));
      const origin=at(offset),matched=slice(offset,offset+args[0].length);
      for(const part of slice(cursor,offset)) append(part);
      let replacement;
      if(typeof rule.replacement==='function') {
        const ranges=matched.length?matched.map(part=>[part.key,part.start,part.text.length]):[[origin.key,origin.start,0]];
        const key=JSON.stringify([stage,rule.id,namespace,meta,ranges,captures,groups]);
        if(!templateRegexMatchCache.has(key)) {
          const value=rule.replacement.apply(api,args);
          if(value && typeof value.then==='function') throw Error('正则替换回调必须同步返回');
          replacement=String(value);
          templateRegexCacheChars+=key.length+replacement.length;
          if(templateRegexMatchCache.size>=4096 || templateRegexCacheChars>4*1024*1024) throw Error('正则回调快照超过上限');
          templateRegexMatchCache.set(key,replacement);
        } else replacement=templateRegexMatchCache.get(key);
      } else replacement=substitution(String(rule.replacement),captures,offset,groups);
      append({...origin,text:replacement});
      cursor=offset+args[0].length;
      return '';
    });
    for(const part of slice(cursor,text.length)) append(part);
    // 空文本保留原来源锚点，后续零宽正则仍可命中。
    parts=result.length?result:[{...at(0),text:''}];
    validate(parts);
  }
  return parts;
};
`;
