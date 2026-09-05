/** 在 QuickJS 中使用官方 EJS 编译器；第三参控制语法，包含器只能返回沙箱内文本，所有回调共享时间与内存限额。 */
export const TEMPLATE_EJS = String.raw`
let depth=0;
const escapeHtml=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&#34;',"'":'&#39;'}[c]));
let __templateEscaper=(value,_locals)=>input.phase==='generate'?String(value ?? ''):escapeHtml(value);
const generateEjsSource=__TavernTemplateLibraries.ejs.Template.prototype.generateSource;
__TavernTemplateLibraries.ejs.Template.prototype.generateSource=function(){
  generateEjsSource.call(this);
  // 在官方语法/空白处理完成后扩展 print；不向原模板加标签，保留行号和 rmWhitespace。
  if(this.opts.outputFunctionName==='print') this.source='const __tavernAppend=print; print=(...values)=>__tavernAppend(values.join(""));\n'+this.source;
};
const copyEjsData=__TavernTemplateLibraries.ejsUtils.shallowCopy;
__TavernTemplateLibraries.ejsUtils.shallowCopy=function(target,source){
  if(source && Object.getPrototypeOf(source)===api) {
    // 官方 include 会复制 locals；补回本沙箱 API，并为子上下文重绑共享定义。
    const inherited=Object.create(null);
    for(const key of Object.keys(source)) if(!Object.hasOwn(api.defines,key)) inherited[key]=source[key];
    Object.setPrototypeOf(target,api);
    return __bindTemplateDefinitions(copyEjsData(target,inherited));
  }
  return copyEjsData(target,source);
};
async function evalTemplate(text,data={},compileOptions={}) {
  if(++depth>16) { depth--; throw Error('模板嵌套超过 16 层'); }
  try {
    if(!compileOptions || typeof compileOptions!=='object' || Array.isArray(compileOptions)) throw Error('EJS options 必须是对象');
    const locals=Object.create(api);
    if(this && this!==globalThis && this!==api) {
      // 继承普通数据；共享定义从原函数重新绑定，不能继承父 locals 上已 bind 的闭包。
      for(const key of Object.keys(this)) if(!Object.hasOwn(api.defines,key)) locals[key]=this[key];
    }
    Object.assign(locals,data);
    __bindTemplateDefinitions(locals);
    const opts={async:true,outputFunctionName:'print',_with:true,localsName:'locals',...compileOptions};
    if(opts._with===false && opts.destructuredLocals===undefined) {
      opts.destructuredLocals=[];
      for(const key in locals) opts.destructuredLocals.push(key);
    }
    opts.context=compileOptions.context===undefined?locals:compileOptions.context;
    opts.escape=compileOptions.escape || compileOptions.escapeFunction || (value=>__templateEscaper(value,locals));
    // api 只属于当前 QuickJS，无宿主 prototype；保留上下文的继承与 define 绑定。
    opts.unsafePrototypeLocals=true;
    if(compileOptions.includer!==undefined) {
      if(typeof compileOptions.includer!=='function') throw Error('EJS includer 必须是函数');
      opts.includer=(originalPath,parsedPath)=>{
        const included=compileOptions.includer(originalPath,parsedPath);
        if(included && typeof included.then==='function') throw Error('EJS includer 必须同步返回 template');
        if(included && typeof included==='object' && Object.hasOwn(included,'template')) {
          if(typeof included.template!=='string') throw Error('EJS includer template 必须是字符串');
          return included;
        }
        return included;
      };
    }
    const result=await __TavernTemplateLibraries.ejs.compile(String(text),opts)(locals);
    if(result.length>1024*1024) throw Error('模板输出超过 1 MiB 上限');
    return result;
  } finally {depth--;}
}
`;
