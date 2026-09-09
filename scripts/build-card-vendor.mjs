/** 将卡面依赖编译成脚本文本；宿主只传递文本，第三方库只在无同源权限的 iframe 内执行。 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({
  stdin: { contents: `import $ from 'jquery'; import _ from 'lodash'; import * as z from 'zod';
    import * as YAML from 'yaml'; import { jsonrepair } from 'jsonrepair';
    Object.assign(window, { $, jQuery: $, _, z, YAML, jsonrepair });`, resolveDir: root },
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
  write: false, minify: true, legalComments: 'inline',
})
const licenses = []
for (const name of ['jquery', 'lodash', 'zod', 'yaml', 'jsonrepair']) {
  const filename = name === 'jsonrepair' ? 'LICENSE.md' : name === 'jquery' ? 'LICENSE.txt' : 'LICENSE'
  const license = await readFile(join(root, 'node_modules', name, filename), 'utf8')
  const { version } = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'))
  licenses.push(`/* ${name} ${version}\n${license.replaceAll('*/', '* /')}\n*/`)
}
const source = licenses.join('\n') + '\n' + result.outputFiles[0].text
const destination = join(root, 'lib/vendor/card-libraries.js')
await mkdir(dirname(destination), { recursive: true })
await writeFile(destination, '/** 自动生成的卡面库脚本文本；禁止在宿主内求值。 */\nexport const CARD_LIBRARIES = ' + JSON.stringify(source) + ';\n')
await writeFile(join(root, 'lib/vendor/card-libraries.d.ts'), '/** 卡面库脚本文本，只供沙箱文档加载。 */\nexport declare const CARD_LIBRARIES: string;\n')
console.log(`build-card-vendor: ${(source.length / 1024).toFixed(1)} KiB`)
