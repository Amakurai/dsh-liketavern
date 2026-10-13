/** 固定 v1 恢复引擎只校验并复制；依赖升级不得重生成或覆盖历史检查点依赖的受信代码。 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=join(dirname(fileURLToPath(import.meta.url)),'..')
const source=join(root,'vendor/checkpoint-engine-v1'),destination=join(root,'lib/vendor/checkpoint-engine-v1')
const expected=Object.freeze({
  'engine.js':'1d4ea4f8afe25475133e15a7f560dff6d73d7c898033cf1e83a7cc96340b3f79',
  'engine.wasm':'105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232',
  LICENSE:'446a69ae534aa8612d8b16d3bfc670c5a5050597dca3ce9820441a60d5d04fbb',
})
const hash=value=>createHash('sha256').update(value).digest('hex')
const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'))
if(manifest.version!==1||manifest.engine!=='quickjs-emscripten@0.32.0/release-sync'
  ||!manifest.files||Object.keys(manifest.files).length!==Object.keys(expected).length
  ||Object.entries(expected).some(([file,digest])=>manifest.files[file]!==digest))throw new Error('固定检查点 v1 引擎清单损坏')
for(const [file,digest] of Object.entries(expected)) {
  if(hash(await readFile(join(source,file)))!==digest)throw new Error(`固定检查点 v1 引擎文件校验失败：${file}`)
}

/** 显式维护核对：只验证公开旧版本能重现现有包；绝不把新依赖或新构建器写回 v1。 */
if(process.argv.includes('--verify-upstream')) {
  for(const [name,version] of Object.entries(manifest.upstream)) {
    const installed=JSON.parse(await readFile(join(root,'node_modules',name,'package.json'),'utf8'))
    if(installed.version!==version)throw new Error(`上游复现要求 ${name}@${version}；普通构建不需要当前依赖仍是该版本`)
  }
  const {build,version}=await import('esbuild')
  if(version!==manifest.esbuild)throw new Error(`上游复现要求 esbuild@${manifest.esbuild}`)
  const entry=`import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
export { newVariant, RELEASE_SYNC };
export const newQuickJSWASMModule = (variant = RELEASE_SYNC) => newQuickJSWASMModuleFromVariant(variant);
`
  const result=await build({stdin:{contents:entry,resolveDir:root,sourcefile:'checkpoint-engine-v1-entry.js'},bundle:true,platform:'node',format:'esm',target:'node24',write:false,minify:true,legalComments:'inline'})
  const license=await readFile(join(root,'node_modules/@jitl/quickjs-wasmfile-release-sync/LICENSE'),'utf8')
  const javascript='/** 固定检查点 v1 引擎；由公开 QuickJS 0.32.0 生成，仅作为受信发布代码加载。 */\n/* '+license.replaceAll('*/','* /')+' */\n'+result.outputFiles[0].text
  if(hash(javascript)!==expected['engine.js']||hash(license)!==expected.LICENSE
    ||hash(await readFile(new URL(import.meta.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'))))!==expected['engine.wasm'])throw new Error('公开上游未能逐字节重现固定检查点 v1 引擎')
  console.log('build-checkpoint-engine: v1 upstream verified')
}

await mkdir(destination,{recursive:true})
for(const file of [...Object.keys(expected),'manifest.json'])await copyFile(join(source,file),join(destination,file))
console.log('build-checkpoint-engine: fixed v1 copied')
