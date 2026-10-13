/** emoji 匹配器构建优化的差分回归：固定别名、边界与 Markdown 产物保持原字节，所有第三方规则仅在可终止 QuickJS worker 内运行。 */
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { optimizeEmojiMatcherSource } from '../scripts/emoji-regex-source.mjs'

const matcherPath=new URL('../node_modules/markdown-it-emoji/lib/normalize_opts.mjs',import.meta.url)

it('固定版本或构建位置变化时明确拒绝，不能静默产出未经审查的匹配器',async()=> {
  const original=await readFile(matcherPath,'utf8')
  expect(()=>optimizeEmojiMatcherSource(original,'3.2.0')).toThrow(/版本改变/)
  expect(()=>optimizeEmojiMatcherSource(original.replace('const scanRE','const changed'),'3.1.0')).toThrow(/构建位置改变/)
  expect(optimizeEmojiMatcherSource(original,'3.1.0')).toContain('Tavern build optimization')
})

it('全部 emoji 名称、重叠候选、空白和特殊语法与原格式化器逐字节一致',async()=> {
  const contents=`
    export {createMessageFormatter} from './src/node/templateMarkdown.ts';
    import normalize from './node_modules/markdown-it-emoji/lib/normalize_opts.mjs';
    import defs from './node_modules/markdown-it-emoji/lib/data/full.mjs';
    export const aliases=Object.keys(defs);
    export function matcher(overrides={}) {
      const options=normalize({defs,shortcuts:{},enabled:[],...overrides});
      return text=>({found:options.scanRE.test(text),matches:[...text.matchAll(options.replaceRE)].map(match=>[match[0],match.index])});
    }
  `
  const bundle=async(optimized:boolean)=>(await build({stdin:{contents,resolveDir:process.cwd()},bundle:true,format:'iife',platform:'browser',write:false,
    globalName:optimized?'OptimizedMarkdown':'OriginalMarkdown',plugins:optimized?[{name:'emoji-matcher-test',setup(builder){
      builder.onLoad({filter:/[\\/]markdown-it-emoji[\\/]lib[\\/]normalize_opts\.mjs$/},async args=>({
        contents:optimizeEmojiMatcherSource(await readFile(args.path,'utf8'),'3.1.0'),loader:'js'}))
    }}]:[]})).outputFiles[0]!.text
  const sources=await Promise.all([bundle(false),bundle(true)])
  const checks=String.raw`
    const equal=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(label)};
    const aliases=OriginalMarkdown.aliases;
    const cases=[aliases.map(name=>':'+name+':').join(' '),
      ':unknown:smile: ::smile:: :smile::smile: :+1: :-1: :smiley: :smile_cat:',
      ' :unknown:smile:unknown:smile: \\:smile: &colon;smile&colon; &#58;smile&#58;',
      '<http://example.test/:smile:> [link :smile:](https://example.test/:smile:) ![:smile:](x.png)',
      '<code>:smile: &amp; </code> \x60:smile:\x60\n\n    :smile:\n\n:smile:',
      '# :smile:\n\n__under :smile:__ ***bold :smile:*** ~~strike :smile:~~',
      '\t:smile:\r\n\r\nzero\u0000 amp & <> " \' _ * \x60 :中文: \ud800\n trailing  ',
      'plain: '+ 'x'.repeat(32*1024)+' :unknown: '+ ' y'.repeat(16*1024)+' :'];
    const originalMatcher=OriginalMarkdown.matcher(),optimizedMatcher=OptimizedMarkdown.matcher();
    const originalFormat=OriginalMarkdown.createMessageFormatter(),optimizedFormat=OptimizedMarkdown.createMessageFormatter();
    let matches=0;
    for(const [index,text] of cases.entries()) {
      const original=originalMatcher(text);equal(original,optimizedMatcher(text),'匹配差异 '+index);matches+=original.matches.length;
      equal(originalFormat(text),optimizedFormat(text),'格式化字节差异 '+index);
    }
    for(const overrides of [{defs:{}},{shortcuts:{smile:[':)'],laughing:':D'}}]) {
      const a=OriginalMarkdown.matcher(overrides),b=OptimizedMarkdown.matcher(overrides);
      for(const text of ['','a :) b :D :smile:','http://a/:smile:']) equal(a(text),b(text),'快捷键与空词表差异');
    }
    const long='普通冒号: '+ 'x'.repeat(1200*1024)+' :unknown: 末尾:';
    const started=Date.now(),output=optimizedFormat(long),elapsed=Date.now()-started;
    equal(output,'<p>'+long+'</p>','长普通冒号正文差异');
    JSON.stringify({aliases:aliases.length,matches,elapsed,length:output.length});
  `
  const result=await new Promise<{aliases:number;matches:number;elapsed:number;length:number}>((resolve,reject)=> {
    const worker=new Worker(String.raw`
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{
        const {getQuickJS}=require('quickjs-emscripten');
        const vm=(await getQuickJS()).newContext();vm.runtime.setMemoryLimit(128*1024*1024);
        const deadline=Date.now()+20000;vm.runtime.setInterruptHandler(()=>Date.now()>deadline);
        try {
          const setup=vm.evalCode(workerData.sources.join('\n'));if(setup.error)throw Error(JSON.stringify(vm.dump(setup.error)));setup.dispose();
          const result=vm.evalCode(workerData.checks);if(result.error)throw Error(JSON.stringify(vm.dump(result.error)));
          const value=JSON.parse(vm.dump(result.value));result.dispose();parentPort.postMessage({value});
        } finally {vm.dispose()}
      })().catch(error=>parentPort.postMessage({error:String(error)}));
    `,{eval:true,execArgv:[],workerData:{sources,checks},resourceLimits:{maxOldGenerationSizeMb:192}})
    const timer=setTimeout(()=>{void worker.terminate();reject(new Error('Markdown 差分 worker 超时'))},25_000)
    worker.once('error',error=>{clearTimeout(timer);void worker.terminate();reject(error)})
    worker.once('message',(message:{value?:{aliases:number;matches:number;elapsed:number;length:number};error?:string})=> {
      clearTimeout(timer);void worker.terminate()
      if(message.error)reject(new Error(message.error));else resolve(message.value!)
    })
  })
  expect(result.aliases).toBe(1903)
  expect(result.matches).toBeGreaterThanOrEqual(1903)
  expect(result.length).toBeGreaterThan(1200*1024)
  // 旧巨型分支扫描同等正文超过 15 秒；这里只容许完整 Markdown 的线性处理开销。
  expect(result.elapsed).toBeLessThan(5000)
},35_000)
