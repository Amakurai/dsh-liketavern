/** 真实文件系统中的运行时读取故障恢复；独立进程验证安装补回后可重试，读取及指纹校验不执行 vendor 代码。 */
import { execFile } from 'node:child_process'
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect,it } from 'vitest'

const execute=promisify(execFile)
const runner=String.raw`
import assert from 'node:assert/strict';
import {writeFile,unlink} from 'node:fs/promises';
import {loadTemplateRuntime} from './src/node/runtime-loader.mjs';
const library='throw Error("vendor must remain text");\r\n',faker='throw Error("faker must remain text");\n';
const destination=new URL('./lib/vendor/template-libraries.js',import.meta.url);
await assert.rejects(loadTemplateRuntime(),error=>error.code==='ENOENT');
await writeFile(destination,library);
const restored=await loadTemplateRuntime();
assert.equal(restored.librarySource,library);assert.equal(restored.fakerSource,faker);
assert.match(restored.hash,/^[a-f0-9]{64}$/);
// 成功读取的版本继续固定在该宿主进程；只清除失败，不引入每轮 vendor 文件扫描。
await unlink(destination);assert.equal(await loadTemplateRuntime(),restored);
console.log(JSON.stringify({recovered:true,cached:true}));
`

it('首次缺 vendor 后补回文件，同一宿主进程可重读且保留成功结果',async()=> {
  const root=await mkdtemp(join(tmpdir(),'tavern-runtime-repair-'))
  try {
    const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/node/templateRuntime.ts',import.meta.url))],
      bundle:true,platform:'node',format:'esm',target:'node24',write:false})
    await mkdir(join(root,'src/node'),{recursive:true})
    await mkdir(join(root,'lib/vendor'),{recursive:true})
    await Promise.all([
      writeFile(join(root,'src/node/runtime-loader.mjs'),bundled.outputFiles[0]!.text),
      writeFile(join(root,'runner.mjs'),runner),
      writeFile(join(root,'lib/vendor/template-faker.js'),'throw Error("faker must remain text");\n'),
    ])
    const result=await execute(process.execPath,[join(root,'runner.mjs')],{cwd:root,windowsHide:true,timeout:10_000})
    expect(JSON.parse(result.stdout.trim())).toEqual({recovered:true,cached:true})
  } finally {await rm(root,{recursive:true,force:true})}
},20_000)
