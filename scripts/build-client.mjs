/**
 * 把 tsc 产出的 lib/client/index.js 打成宿主可加载的单文件 CJS bundle（lib/client.js）。
 * 宿主提供的模块保持 external（bundle 内为 require(...)），产物外包 ModuleLoader 注册壳。
 * 用法：node scripts/build-client.mjs（须在 npx tsc 之后运行，npm run build 已串好）。
 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 宿主模块表提供的依赖，保持 require 引入。 */
const external = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

const result = await build({
  entryPoints: [join(root, 'lib/client/index.js')],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  external,
  write: false,
  logLevel: 'info',
})

const code = result.outputFiles[0].text

const banner = `window.__ModuleLoader__.load({
  id: "dsh-liketavern",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`
const footer = `
    return module.exports;
  }
});
`

const out = join(root, 'lib/client.js')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, banner + code + footer, 'utf8')

// 简单自检：产物必须包含 ModuleLoader 包裹与三个导出（ESM 输入经 __export 导出）。
const written = await readFile(out, 'utf8')
for (const needle of ['window.__ModuleLoader__.load', '"dsh-liketavern"', 'apply: () =>', 'inject: () =>', 'name: () =>', 'return module.exports']) {
  if (!written.includes(needle)) throw new Error(`build-client: 产物缺少 ${needle}`)
}
console.log(`build-client: wrote ${out} (${(written.length / 1024).toFixed(1)} KiB)`)
