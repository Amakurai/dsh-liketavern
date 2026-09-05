/** 将受信任的模板库打包为只在 QuickJS 中求值的脚本；固定依赖来自锁文件，保留许可证。 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import * as faker from '@faker-js/faker'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 保存所有语言原始数据，但延迟 JSON.parse；普通模板无需展开语言数据或实例。
const fakerLocaleJson = Object.fromEntries(Object.entries(faker.allLocales).map(([code,locale])=>[code,JSON.stringify(locale)]))
const fakerFallbacks = {}
for (const [code,instance] of Object.entries(faker.allFakers)) {
  const parts=code.split('_'), chain=[code]
  while(parts.length>1) { parts.pop(); const parent=parts.join('_'); if(Object.hasOwn(faker.allLocales,parent)) chain.push(parent) }
  if(code!=='base') chain.push('en','base')
  const fallback=[...new Set(chain)]
  if(!isDeepStrictEqual(faker.mergeLocales(fallback.map(key=>faker.allLocales[key])),instance.rawDefinitions)) throw new Error(`Faker ${code} fallback 与官方实例不一致`)
  fakerFallbacks[code]=fallback
}
const fakerInstanceNames=Object.fromEntries(Object.entries(faker).filter(([name])=>name.startsWith('faker')).map(([name,instance])=>[name,Object.entries(faker.allFakers).find(([,value])=>value===instance)?.[0]]))
if(Object.values(fakerInstanceNames).some(value=>!value)) throw new Error('Faker 实例导出无法映射到官方 locale')
const fakerCoreExports=Object.keys(faker).filter(name=>!name.startsWith('faker')&&!Object.hasOwn(faker.allLocales,name)&&!['allFakers','allLocales'].includes(name))
const fakerCoreSource=`export { ${fakerCoreExports.join(',')} } from '@faker-js/faker';`
// Faker 的 JWT 使用 UTF-8 与 Base64；纯 JS 编码器注入库内部，不提供 Buffer 或宿主函数。
const encodingSource=String.raw`
export class TextEncoder {
  encode(value='') {
    const bytes=[];
    for(const character of String(value)) {
      let point=character.codePointAt(0);
      if(point>=0xd800 && point<=0xdfff) point=0xfffd;
      if(point<0x80) bytes.push(point);
      else if(point<0x800) bytes.push(0xc0|(point>>>6),0x80|(point&63));
      else if(point<0x10000) bytes.push(0xe0|(point>>>12),0x80|((point>>>6)&63),0x80|(point&63));
      else bytes.push(0xf0|(point>>>18),0x80|((point>>>12)&63),0x80|((point>>>6)&63),0x80|(point&63));
    }
    return Uint8Array.from(bytes);
  }
}
export function btoa(value) {
  const text=String(value), alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output='';
  for(let at=0;at<text.length;at+=3) {
    const a=text.charCodeAt(at),b=text.charCodeAt(at+1),c=text.charCodeAt(at+2);
    if(a>255 || b>255 || c>255) throw Error('Invalid character in Base64 input');
    output+=alphabet[a>>>2]+alphabet[((a&3)<<4)|(Number.isNaN(b)?0:b>>>4)];
    output+=Number.isNaN(b)?'=':alphabet[((b&15)<<2)|(Number.isNaN(c)?0:c>>>6)];
    output+=Number.isNaN(c)?'=':alphabet[c&63];
  }
  return output;
}`
const result = await build({
  stdin:{contents:'export { z } from "zod"; export { default as lodash } from "lodash"; export { jsonrepair } from "jsonrepair"; export { default as ejs } from "ejs"; export { default as showdown } from "showdown"; export { default as ejsUtils } from "tavern-ejs-utils";',resolveDir:root,sourcefile:'template-libraries-entry.js'},
  bundle:true,format:'iife',globalName:'__TavernTemplateLibraries',platform:'browser',target:'es2022',
  write:false,minify:true,legalComments:'inline',
  plugins:[{name:'ejs-virtual-files',setup(builder) {
    // QuickJS 不提供过时的 RegExp.$1/$2；只替换 Showdown 两处捕获读取，保留官方解析流程。
    builder.onLoad({filter:/[\\/]showdown[\\/]dist[\\/]showdown\.js$/},async args=>{
      let source=(await readFile(args.path,'utf8')).replaceAll('\r\n','\n')
      const rewrites=[
        [String.raw`while (/¨C(\d+)C/.test(repText)) {
      var num = RegExp.$1;`,String.raw`var spanMatch;
    while ((spanMatch = /¨C(\d+)C/.exec(repText))) {
      var num = spanMatch[1];`],
        [String.raw`while (/¨(K|G)(\d+)\1/.test(grafsOutIt)) {
      var delim = RegExp.$1,
          num   = RegExp.$2;`,String.raw`var blockMatch;
    while ((blockMatch = /¨(K|G)(\d+)\1/.exec(grafsOutIt))) {
      var delim = blockMatch[1],
          num   = blockMatch[2];`],
      ]
      for(const [before,after] of rewrites) {
        if(source.split(before).length!==2) throw new Error('Showdown 静态捕获适配与已固定版本不一致')
        source=source.replace(before,after)
      }
      return {contents:source,loader:'js'}
    })
    builder.onResolve({filter:/^tavern-ejs-utils$/},()=>({path:join(root,'node_modules/ejs/lib/esm/utils.js')}))
    builder.onResolve({filter:/^node:(fs|path)$/},args=>({path:args.path,namespace:'ejs-virtual-files'}))
    builder.onLoad({filter:/.*/,namespace:'ejs-virtual-files'},args=>({loader:'js',contents:args.path==='node:fs'
      ? `export default {existsSync:()=>false,readFileSync(){throw Error('EJS include 不允许读取文件；请提供返回 template 的沙箱 includer')}};`
      : String.raw`
        // 只做虚拟 POSIX 路径运算，根目录恒为 /；没有 cwd、环境或磁盘访问。
        const normalize=value=>{
          const parts=[];
          for(const part of String(value).split('/')) { if(!part || part==='.') continue; if(part==='..') parts.pop(); else parts.push(part); }
          return '/'+parts.join('/');
        };
        const resolve=(...parts)=>{let path='';for(const part of parts){if(typeof part!=='string')throw TypeError('虚拟路径必须是字符串');path=part.startsWith('/')?part:path+'/'+part}return normalize(path)};
        const basename=(path,suffix='')=>{const name=String(path).replace(/\/+$/,'').split('/').pop()||'';return suffix && name.endsWith(suffix)?name.slice(0,-suffix.length):name};
        const dirname=path=>{const text=String(path).replace(/\/+$/,''),at=text.lastIndexOf('/');return at<0?'.':at===0?'/':text.slice(0,at)};
        const extname=path=>{const name=basename(path),at=name.lastIndexOf('.');return at>0 && name!=='..'?name.slice(at):''};
        export default {resolve,basename,dirname,extname};
      `}))
  }}],
})
const fakerResult=await build({
  stdin:{contents:`export * as fakerCore from "tavern-faker-core";
    export const fakerLocaleJson=${JSON.stringify(fakerLocaleJson)};
    export const fakerFallbacks=${JSON.stringify(fakerFallbacks)};
    export const fakerInstanceNames=${JSON.stringify(fakerInstanceNames)};`,resolveDir:root,sourcefile:'template-faker-entry.js'},
  bundle:true,format:'iife',globalName:'__TavernFakerLibraries',platform:'browser',target:'es2022',
  write:false,minify:true,legalComments:'inline',charset:'utf8',
  inject:['tavern-faker-encoding'],
  plugins:[{name:'tavern-faker',setup(builder) {
    builder.onResolve({filter:/^tavern-faker-(core|encoding)$/},args=>({path:args.path,namespace:'tavern-faker'}))
    builder.onLoad({filter:/.*/,namespace:'tavern-faker'},args=>({contents:args.path==='tavern-faker-core'?fakerCoreSource:encodingSource,resolveDir:root,loader:'js'}))
  }}],
})
const licenses=new Map()
for (const name of ['zod','lodash','jsonrepair','ejs','showdown','@faker-js/faker']) {
  const license = await readFile(join(root,'node_modules',name,name==='jsonrepair' ? 'LICENSE.md' : 'LICENSE'),'utf8')
  const version = JSON.parse(await readFile(join(root,'node_modules',name,'package.json'),'utf8')).version
  licenses.set(name,`/* ${name} ${version}\n${license.replaceAll('*/','* /')}\n*/`)
}
for(const [filename,bundle,names] of [['template-libraries.js',result,['zod','lodash','jsonrepair','ejs','showdown']],['template-faker.js',fakerResult,['@faker-js/faker']]]) {
  const source = `/** 模板沙箱依赖产物，由 scripts/build-template-vendor.mjs 生成。 */\n${names.map(name=>licenses.get(name)).join('\n')}\n${bundle.outputFiles[0].text}`
  const destination = join(root,'lib/vendor',filename)
  await mkdir(dirname(destination),{recursive:true})
  await writeFile(destination,source,'utf8')
  console.log(`build-template-vendor: ${filename} ${(source.length/1024).toFixed(1)} KiB`)
}
