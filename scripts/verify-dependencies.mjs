/**
 * 依赖声明边界检查：直接导入必须直接声明，服务端运行依赖不得藏在开发依赖里。
 * 浏览器入口经构建打包，React 与宿主 UI 模块由 ModuleLoader 提供，允许只声明开发依赖。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 提取 ESM 导入/再导出、动态 import 和 CommonJS 引用，保留纯类型导入标记。 */
export function packageReferences(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const references = []
  const add = (specifier, typeOnly = false) => {
    if (typeof specifier !== 'string' || specifier.startsWith('.') || specifier.startsWith('/')
      || /^[A-Za-z]:[\\/]/.test(specifier) || isBuiltin(specifier)) return
    const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
    references.push({ file: file.replaceAll('\\', '/'), name, typeOnly })
  }
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const typeOnly = clause?.isTypeOnly === true || (!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly))
      add(node.moduleSpecifier.text, Boolean(typeOnly))
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const exports = node.exportClause
      const typeOnly = node.isTypeOnly || (exports && ts.isNamedExports(exports) && exports.elements.length > 0
        && exports.elements.every(element => element.isTypeOnly))
      add(node.moduleSpecifier.text, Boolean(typeOnly))
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const named = ts.isIdentifier(callee) && callee.text === 'require'
      const resolved = ts.isPropertyAccessExpression(callee)
        && ((ts.isIdentifier(callee.expression) && callee.expression.text === 'require' && callee.name.text === 'resolve')
          || (callee.expression.kind === ts.SyntaxKind.MetaProperty && callee.expression.getText(ast) === 'import.meta'
            && callee.name.text === 'resolve'))
      const argument = node.arguments[0]
      if ((callee.kind === ts.SyntaxKind.ImportKeyword || named || resolved) && argument && ts.isStringLiteral(argument)) {
        add(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return references
}

/** 服务端源码必须声明 dependencies/peerDependencies；其余源码与工具也必须有直接声明。 */
export function inspectDependencyDeclarations(pkg, references) {
  const errors = new Set()
  for (const { file, name, typeOnly } of references) {
    const runtime = pkg.dependencies?.[name] !== undefined || pkg.peerDependencies?.[name] !== undefined
    const declared = runtime || pkg.devDependencies?.[name] !== undefined
    if (!declared) errors.add(`${file} 直接使用 ${name}，但依赖表未声明`)
    else if (file.startsWith('src/') && !file.startsWith('src/client/') && !typeOnly && !runtime) {
      errors.add(`${file} 运行时使用 ${name}，但只声明了 devDependencies`)
    }
  }
  return [...errors]
}

/** 只扫描项目维护的输入，忽略发布产物与冻结 vendor，避免间接依赖遮蔽源码遗漏。 */
export function projectReferences(directory = root) {
  const references = []
  const scan = file => {
    if (!/\.(?:[cm]?js|tsx?)$/.test(file)) return
    references.push(...packageReferences(readFileSync(file, 'utf8'), relative(directory, file)))
  }
  const walk = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) scan(file)
    }
  }
  for (const folder of ['src', 'test', 'scripts']) walk(join(directory, folder))
  for (const entry of readdirSync(directory)) if (/\.config\.[cm]?[jt]s$/.test(entry)) scan(join(directory, entry))
  return references
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const references = projectReferences()
  const errors = inspectDependencyDeclarations(pkg, references)
  if (errors.length) {
    console.error(`依赖声明不完整（${errors.length} 处）：\n${errors.map(error => `- ${error}`).join('\n')}`)
    process.exitCode = 1
  } else {
    console.log(`依赖声明完整：已核对 ${new Set(references.map(reference => reference.name)).size} 个直接引用包`)
  }
}
