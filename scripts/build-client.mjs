/**
 * 把 tsc 产出的 lib/client/index.js 打成宿主可加载的单文件 CJS bundle（lib/client.js）。
 * 宿主提供的模块保持 external（bundle 内为 require(...)），产物外包 ModuleLoader 注册壳。
 * 用法：node scripts/build-client.mjs（须在 npx tsc 之后运行，npm run build 已串好）。
 */
import { build } from 'esbuild-vendor'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 宿主 seed 模块表提供的依赖，保持 require 引入（0.1.2 的 seed 词：react 系、cordis、ui-slots、ui-primitives、client-store）。 */
const external = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const result = await build({
  entryPoints: [join(root, 'lib/client/index.js')],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  charset: 'utf8',
  minifyWhitespace: true,
  minifySyntax: true,
  // 保留标识符名：卡面 iframe 桥接通过 Function.prototype.toString() 注入沙箱源码。
  minifyIdentifiers: false,
  legalComments: 'none',
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

const bundleText = banner + code + footer
// 自检先于落盘：产物必须包含 ModuleLoader 包裹与三个导出（ESM 输入经 __export 导出）。
const requiredChecks = [
  ['window.__ModuleLoader__.load', /window\.__ModuleLoader__\.load/],
  ['"dsh-liketavern"', /"dsh-liketavern"/],
  ['apply export', /\bapply:\s*\(\)\s*=>/],
  ['inject export', /\binject:\s*\(\)\s*=>/],
  ['name export', /\bname:\s*\(\)\s*=>/],
  ['return module.exports', /return module\.exports/],
]
for (const [label, pattern] of requiredChecks) {
  if (!pattern.test(bundleText)) throw new Error(`build-client: 产物缺少 ${label}`)
}

const out = join(root, 'lib/client.js')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, bundleText, 'utf8')
console.log(`build-client: wrote ${out} (${(Buffer.byteLength(bundleText, 'utf8') / 1024).toFixed(1)} KiB)`)
