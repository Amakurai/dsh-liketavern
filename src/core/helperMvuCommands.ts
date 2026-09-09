/** MVU 普通 JSON 命令编解码：独立有界字面量解析、路径校验及原子应用，可把工厂序列化进不透明卡面沙箱。 */
export interface HelperMvuCommand {
  type: 'set' | 'add' | 'insert' | 'delete' | 'move' | 'copy' | 'test'
  full_match: string
  args: string[]
  reason: string
}
export interface HelperMvuCommandCodec {
  parse(message: string): HelperMvuCommand[]
  apply(statData: Record<string, unknown>, commands: HelperMvuCommand[], displayBase?: Record<string, unknown>): {
    stat_data: Record<string, unknown>; display_data: Record<string, unknown>; delta_data: Record<string, unknown>
  }
}

/** json 必须是不调用访问器的有界普通 JSON 复制器；工厂不捕获模块变量、不使用代码求值或第三方解析器。 */
export function createHelperMvuCommandCodec(json: (value: unknown, maxBytes?: number) => unknown): HelperMvuCommandCodec {
  type Table = Record<string, unknown>
  type Command = HelperMvuCommand
  const INPUT = 256 * 1024, OUTPUT = 1024 * 1024, MAX_COMMANDS = 256, DEPTH = 64
  const encoder = new TextEncoder()
  const record = (value: unknown): value is Table => value !== null && typeof value === 'object' && !Array.isArray(value)
  const size = (text: string) => encoder.encode(text).length
  const checkKey = (key: string) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('MVU 路径或数据包含污染字段')
    if (['$meta', '$arrayMeta', '$internal'].includes(key)) throw new Error('暂不支持 MVU 模板元数据或内部状态字段')
  }
  const checkMetadata = (value: unknown, depth = 0): void => {
    if (depth > DEPTH) throw new Error('MVU 数据嵌套超过 64 层')
    if (value === '$__META_EXTENSIBLE__$') throw new Error('暂不支持 MVU 数组模板元数据')
    if (Array.isArray(value)) for (const item of value) checkMetadata(item, depth + 1)
    else if (record(value)) for (const key of Object.keys(value)) { checkKey(key); checkMetadata(value[key], depth + 1) }
  }
  const copy = (value: unknown) => { const result = json(value, OUTPUT); checkMetadata(result); return result }
  const table = (value: unknown): Table => {
    const result = copy(value)
    if (!record(result)) throw new Error('MVU stat_data 根必须是普通 JSON 对象')
    return result
  }
  const whitespace = (char: string | undefined) => char !== undefined && char.trim() === ''
  const skip = (text: string, start: number) => { let at = start; while (whitespace(text[at])) at++; return at }
  const quoted = (text: string, start: number): { value: string; end: number } => {
    const quote = text[start]
    if (quote !== '"' && quote !== "'") throw new Error('MVU 字符串必须使用单引号或双引号')
    let value = '', at = start + 1
    while (at < text.length) {
      const char = text[at++]!
      if (char === quote) return { value, end: at }
      if (char.charCodeAt(0) < 32) throw new Error('MVU 字符串包含未转义控制字符')
      if (char !== '\\') { value += char; continue }
      const escaped = text[at++]
      const chars: Record<string, string> = { '"': '"', "'": "'", '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }
      if (escaped !== undefined && Object.hasOwn(chars, escaped)) { value += chars[escaped]; continue }
      const digits = escaped === 'u' ? 4 : escaped === 'x' ? 2 : 0
      if (!digits) throw new Error('MVU 字符串包含不支持的转义')
      const hex = text.slice(at, at + digits)
      if (hex.length !== digits || !/^[0-9a-f]+$/i.test(hex)) throw new Error('MVU 字符串 Unicode 转义无效')
      value += String.fromCharCode(Number.parseInt(hex, 16)); at += digits
    }
    throw new Error('MVU 字符串未闭合')
  }
  const literal = (source: unknown): unknown => {
    // 官方命令事件可以把 args 从原文字面量改成实际 JSON 值；复制验证后直接使用，不隐式 stringify 执行。
    if (typeof source !== 'string') return copy(source)
    let at = 0
    const read = (depth: number): unknown => {
      if (depth > DEPTH) throw new Error('MVU 字面量嵌套超过 64 层')
      at = skip(source, at)
      const char = source[at]
      if (char === '"' || char === "'") { const result = quoted(source, at); at = result.end; return result.value }
      if (char === '[' || char === '{') {
        const array = char === '[', end = array ? ']' : '}', result: unknown[] | Table = array ? [] : {}
        at++; at = skip(source, at)
        if (source[at] === end) { at++; return result }
        while (at < source.length) {
          let key = ''
          if (!array) {
            at = skip(source, at)
            if (source[at] === '"' || source[at] === "'") { const item = quoted(source, at); key = item.value; at = item.end }
            else {
              const start = at
              while (at < source.length && !whitespace(source[at]) && !':,{}[]()"\'`'.includes(source[at]!)) at++
              key = source.slice(start, at)
              if (!key) throw new Error('MVU 对象键无效')
            }
            checkKey(key); at = skip(source, at)
            if (source[at++] !== ':') throw new Error('MVU 只接受对象字面量，不支持访问器或表达式')
            if (Object.hasOwn(result, key)) throw new Error('MVU 对象字面量包含重复键')
          }
          const value = read(depth + 1)
          if (array) (result as unknown[]).push(value); else (result as Table)[key] = value
          at = skip(source, at)
          if (source[at] === end) { at++; return result }
          if (source[at++] !== ',') throw new Error('MVU 数组或对象分隔符无效')
          at = skip(source, at)
          if (source[at] === end) { at++; return result }
        }
        throw new Error('MVU 数组或对象未闭合')
      }
      for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
        if (source.startsWith(word, at)) { at += word.length; return value }
      }
      const number = source.slice(at).match(/^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)
      if (number) { at += number[0].length; const value = Number(number[0]); if (Number.isFinite(value)) return value }
      throw new Error('MVU 只支持有界 JSON 字面量；暂不支持数学、函数或模板表达式，字符串请加引号')
    }
    const value = read(0)
    if (skip(source, at) !== source.length) throw new Error('MVU 字面量包含不支持的表达式或多余文本')
    return copy(value)
  }
  const path = (source: unknown): string[] => {
    if (typeof source !== 'string') throw new Error('MVU 路径必须是字符串')
    let text = source.trim()
    if (text.startsWith('"') || text.startsWith("'")) {
      const decoded = literal(text)
      if (typeof decoded !== 'string') throw new Error('MVU 路径字面量无效')
      text = decoded
    }
    if (text === '') return []
    const parts: string[] = []; let at = 0, needSegment = true
    const add = (key: string) => { checkKey(key); parts.push(key); if (parts.length > DEPTH) throw new Error('MVU 路径超过 64 层') }
    while (at < text.length) {
      if (text[at] === '.') {
        if (needSegment) throw new Error('MVU 路径包含空段')
        at++; needSegment = true; continue
      }
      if (text[at] === '[') {
        at++; at = skip(text, at); let key: string
        if (text[at] === '"' || text[at] === "'") { const item = quoted(text, at); key = item.value; at = skip(text, item.end) }
        else { const start = at; while (at < text.length && text[at] !== ']') at++; key = text.slice(start, at).trim(); if (!key) throw new Error('MVU 路径方括号不能为空') }
        if (text[at++] !== ']') throw new Error('MVU 路径方括号未闭合')
        add(key); needSegment = false
      } else {
        if (!needSegment) throw new Error('MVU 路径缺少分隔符')
        let key: string
        if (text[at] === '"' || text[at] === "'") { const item = quoted(text, at); key = item.value; at = item.end }
        else { const start = at; while (at < text.length && text[at] !== '.' && text[at] !== '[' && text[at] !== ']') at++; key = text.slice(start, at); if (!key || key.trim() !== key) throw new Error('MVU 路径字段无效') }
        add(key); needSegment = false
      }
    }
    if (needSegment) throw new Error('MVU 路径末尾为空')
    return parts
  }
  const encodePath = (parts: string[]) => parts.map(key => '[' + JSON.stringify(key) + ']').join('')
  const pointer = (value: unknown): string[] => {
    if (typeof value !== 'string' || value !== '' && !value.startsWith('/')) throw new Error('MVU JSON Patch 路径必须是 JSON Pointer')
    if (value === '') return []
    const parts = value.slice(1).split('/').map(part => {
      let result = ''
      for (let at = 0; at < part.length; at++) {
        const char = part[at]!
        if (char !== '~') result += char
        else { const escape = part[++at]; if (escape !== '0' && escape !== '1') throw new Error('MVU JSON Pointer 转义无效'); result += escape === '0' ? '~' : '/' }
      }
      checkKey(result); return result
    })
    if (parts.length > DEPTH) throw new Error('MVU 路径超过 64 层')
    return parts
  }
  const alias = (type: string): Command['type'] => {
    if (type === 'assign') return 'insert'
    if (type === 'remove' || type === 'unset') return 'delete'
    if (['set', 'add', 'insert', 'delete', 'move', 'copy', 'test'].includes(type)) return type as Command['type']
    throw new Error('暂不支持此 MVU 命令：' + type)
  }
  const arity = (type: Command['type'], count: number) => {
    const okay = type === 'set' || type === 'insert' ? count === 2 || count === 3 : type === 'delete' ? count === 1 || count === 2 : count === 2
    if (!okay) throw new Error('MVU ' + type + ' 命令参数数量无效')
  }
  const patchCommands = (body: string): Command[] => {
    let text = body.trim()
    if (text.startsWith('```')) {
      const line = text.indexOf('\n')
      if (line < 0 || !text.endsWith('```')) throw new Error('MVU JSON Patch 代码块未闭合')
      text = text.slice(line + 1, -3).trim()
    }
    let value: unknown
    try { value = json(JSON.parse(text), INPUT) } catch { throw new Error('MVU JSON Patch 必须是有界有效 JSON') }
    if (!Array.isArray(value) || value.length > MAX_COMMANDS) throw new Error('MVU JSON Patch 最多 256 个操作')
    return value.map(op => {
      if (!record(op) || typeof op.op !== 'string') throw new Error('MVU JSON Patch 操作无效')
      const parts = pointer(op.path), target = encodePath(parts), command = { full_match: JSON.stringify(op), reason: 'json_patch' }
      const requireValue = () => { if (!Object.hasOwn(op, 'value')) throw new Error('MVU JSON Patch 操作缺少 value'); return JSON.stringify(op.value) }
      if (op.op === 'replace') return { ...command, type: 'set', args: [target, requireValue()] }
      if (op.op === 'delta') return { ...command, type: 'add', args: [target, requireValue()] }
      if (op.op === 'add' || op.op === 'insert') {
        if (!parts.length) return { ...command, type: 'set', args: ['', requireValue()] }
        const key = parts.at(-1)!
        return { ...command, type: 'insert', args: [encodePath(parts.slice(0, -1)), JSON.stringify(key), requireValue()] }
      }
      if (op.op === 'remove') return { ...command, type: 'delete', args: [target] }
      if (op.op === 'move' || op.op === 'copy') return { ...command, type: op.op, args: [encodePath(pointer(op.from)), target] }
      if (op.op === 'test') return { ...command, type: 'test', args: [target, requireValue()] }
      throw new Error('暂不支持此 MVU JSON Patch 操作：' + op.op)
    })
  }
  const parse = (message: string): Command[] => {
    if (typeof message !== 'string' || message.length > INPUT || size(message) > INPUT) throw new Error('MVU 命令文本超过 256 KiB 或不是字符串')
    if (message.trim() === '[]' || /^\[\s*\{/.test(message.trim())) return patchCommands(message)
    const result: Command[] = []
    const append = (command: Command) => { if (result.length >= MAX_COMMANDS) throw new Error('MVU 单次最多 256 个命令'); result.push(command) }
    let at = 0
    while (at < message.length) {
      const tag = message[at] === '<' ? ['jsonpatch', 'json_patch'].find(name => message.slice(at, at + name.length + 2).toLowerCase() === '<' + name + '>') : undefined
      if (tag) {
        let end = at + tag.length + 2
        const close = '</' + tag + '>'
        while (end < message.length && message.slice(end, end + close.length).toLowerCase() !== close) {
          if (message[end] === '"' || message[end] === "'") end = quoted(message, end).end
          else end++
        }
        if (end >= message.length) throw new Error('MVU JSON Patch 标签未闭合')
        for (const command of patchCommands(message.slice(at + tag.length + 2, end))) append(command)
        at = end + tag.length + 3; continue
      }
      if (!message.startsWith('_.', at)) { at++; continue }
      const start = at; at += 2; const nameStart = at
      while (at < message.length && /[a-z]/i.test(message[at]!)) at++
      const name = message.slice(nameStart, at)
      if (!['set', 'add', 'insert', 'assign', 'delete', 'remove', 'unset', 'move', 'copy', 'test'].includes(name)) continue
      at = skip(message, at)
      if (message[at] !== '(') continue
      const type = alias(name), args: string[] = [], stack: string[] = []
      at++; let begin = at, closed = false
      while (at < message.length) {
        const char = message[at]!
        if (char === '"' || char === "'") { at = quoted(message, at).end; continue }
        if (char === '`') throw new Error('暂不支持 MVU 模板字符串')
        if ('([{'.includes(char)) { stack.push(char); if (stack.length > DEPTH) throw new Error('MVU 命令嵌套超过 64 层') }
        else if (')]}'.includes(char)) {
          if (char === ')' && !stack.length) { const arg = message.slice(begin, at).trim(); if (arg) args.push(arg); at++; closed = true; break }
          const open = stack.pop(); if (open !== ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[char]) throw new Error('MVU 命令括号不匹配')
        } else if (char === ',' && !stack.length) { const arg = message.slice(begin, at).trim(); if (!arg) throw new Error('MVU 命令参数为空'); args.push(arg); begin = at + 1 }
        at++
      }
      if (!closed) throw new Error('MVU 命令未闭合')
      at = skip(message, at)
      if (message[at++] !== ';') throw new Error('MVU 命令必须以分号结束')
      let reason = '', after = at
      while (message[after] === ' ' || message[after] === '\t') after++
      if (message.startsWith('//', after)) { const newline = message.indexOf('\n', after); at = newline < 0 ? message.length : newline; reason = message.slice(after + 2, at).trim() }
      arity(type, args.length); append({ type, args, reason, full_match: message.slice(start, at) })
    }
    return result
  }
  const arrayIndex = (key: string, length: number, insert = false): number => {
    if (insert && key === '-') return length
    if (!/^(0|[1-9][0-9]*)$/.test(key)) throw new Error('MVU 数组下标必须是规范非负整数')
    const index = Number(key)
    if (!Number.isSafeInteger(index) || index < 0 || index > length || !insert && index === length) throw new Error('MVU 数组下标越界')
    return index
  }
  const get = (root: unknown, parts: string[]): unknown => {
    let value = root
    for (const key of parts) {
      if (Array.isArray(value)) value = value[arrayIndex(key, value.length)]
      else if (record(value) && Object.hasOwn(value, key)) value = value[key]
      else throw new Error('MVU 目标路径不存在：' + encodePath(parts))
    }
    return value
  }
  const write = (root: Table, parts: string[], value: unknown, insert: boolean): Table => {
    if (!parts.length) return table(value)
    const parent = get(root, parts.slice(0, -1)), key = parts.at(-1)!
    if (Array.isArray(parent)) { const index = arrayIndex(key, parent.length, insert); if (insert) parent.splice(index, 0, value); else parent[index] = value }
    else if (record(parent)) { if (!insert && !Object.hasOwn(parent, key)) throw new Error('MVU 目标字段不存在'); parent[key] = value }
    else throw new Error('MVU 目标父路径不是集合')
    return root
  }
  const remove = (root: Table, parts: string[]): void => {
    if (!parts.length) throw new Error('暂不支持删除 MVU stat_data 根对象')
    const parent = get(root, parts.slice(0, -1)), key = parts.at(-1)!
    if (Array.isArray(parent)) parent.splice(arrayIndex(key, parent.length), 1)
    else if (record(parent) && Object.hasOwn(parent, key)) delete parent[key]
    else throw new Error('MVU 删除目标不存在')
  }
  const equal = (a: unknown, b: unknown) => JSON.stringify(json(a, OUTPUT)) === JSON.stringify(json(b, OUTPUT))
  const merge = (target: unknown, value: unknown, depth = 0): unknown => {
    if (depth > DEPTH) throw new Error('MVU 合并超过 64 层')
    if (Array.isArray(value)) {
      const result = Array.isArray(target) ? target : []
      for (let i = 0; i < value.length; i++) result[i] = merge(result[i], value[i], depth + 1)
      return result
    }
    if (record(value)) {
      const result = record(target) ? target : {}
      for (const key of Object.keys(value)) result[key] = merge(result[key], value[key], depth + 1)
      return result
    }
    return value
  }
  const logAt = (root: Table, parts: string[], text: string) => {
    const keys = parts.length ? parts : ['']; let container: Table | unknown[] = root
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!
      if (Array.isArray(container)) {
        const index = Number(key)
        if (!Number.isSafeInteger(index) || index < 0 || index > 65536) throw new Error('MVU 显示路径数组下标越界')
        while (container.length <= index) container.push(null)
        if (i === keys.length - 1) { container[index] = text; return }
        const child = container[index]
        if (!record(child) && !Array.isArray(child)) container[index] = {}
        container = container[index] as Table | unknown[]
      } else {
        if (i === keys.length - 1) { container[key] = text; return }
        const child = container[key]
        if (!record(child) && !Array.isArray(child)) container[key] = {}
        container = container[key] as Table | unknown[]
      }
    }
  }
  const printable = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value)
  const vwd = (value: unknown): value is [unknown, string] => Array.isArray(value) && value.length === 2 && typeof value[1] === 'string' && !Array.isArray(value[0])
  const apply: HelperMvuCommandCodec['apply'] = (statData, commands, displayBase = statData) => {
    let stat = table(statData)
    const display = table(displayBase), delta: Table = {}, rows = json(commands, OUTPUT)
    if (!Array.isArray(rows) || rows.length > MAX_COMMANDS) throw new Error('MVU 单次最多 256 个命令')
    let argumentBytes = 0
    for (const row of rows) {
      if (!record(row) || typeof row.type !== 'string' || typeof row.full_match !== 'string' || typeof row.reason !== 'string' || !Array.isArray(row.args)) throw new Error('MVU 命令结构无效')
      const type = alias(row.type), args: unknown[] = row.args
      arity(type, args.length)
      argumentBytes += size(row.reason) + args.reduce<number>((sum, item) => sum + size(typeof item === 'string' ? item : JSON.stringify(item)), 0)
      if (argumentBytes > INPUT) throw new Error('MVU 命令参数超过 256 KiB')
      const parts = path(args[0]), isPatch = row.reason === 'json_patch', suffix = row.reason ? '(' + row.reason + ')' : ''
      const rawPath = String(args[0]).trim()
      const label = rawPath.startsWith('"') || rawPath.startsWith("'") ? String(literal(rawPath)) : rawPath
      let log = '', logPath = parts
      if (type === 'set' || type === 'add') {
        const previous = get(stat, parts), wrapped = !isPatch && vwd(previous), oldValue = wrapped ? previous[0] : previous
        if (type === 'set' && args.length === 3) literal(args[1])
        let value = literal(args.at(-1))
        if (type === 'add') {
          // 日期字符串和数学式需要原版额外解释器，不能在这个 JSON 适配里按字符串连接或隐式日期解析。
          if (typeof oldValue !== 'number' || typeof value !== 'number') throw new Error('MVU add 仅支持有限数字；暂不支持日期或表达式')
          value = Number((oldValue + value).toPrecision(12))
        } else if (!isPatch && typeof oldValue === 'number' && value !== null && (wrapped || typeof value === 'string')) value = Number(value)
        value = copy(value)
        if (wrapped) previous[0] = value
        else stat = write(stat, parts, value, false)
        log = printable(oldValue) + '->' + printable(value) + ' ' + suffix
      } else if (type === 'insert') {
        let collection = get(stat, parts), value = literal(args.at(-1))
        if (collection === null && !isPatch) { collection = args.length === 2 && Array.isArray(value) ? [] : {}; stat = write(stat, parts, collection, false) }
        if (args.length === 2) {
          if (Array.isArray(collection)) { collection.push(value); log = 'ASSIGNED ' + JSON.stringify(value) + " into array '" + label + "' " + suffix }
          else if (record(collection) && record(value)) { merge(collection, value); log = 'MERGED object ' + JSON.stringify(value) + " into object '" + label + "' " + suffix }
          else throw new Error('MVU insert 的两参数形式需要数组或对象合并')
        } else {
          const key = literal(args[1])
          if (Array.isArray(collection)) {
            let index: number
            if (isPatch) { if (typeof key !== 'string' && typeof key !== 'number') throw new Error('MVU JSON Patch 数组下标无效'); index = arrayIndex(String(key), collection.length, true) }
            else if (key === '-') index = collection.length
            else if (typeof key === 'number' && Number.isSafeInteger(key)) index = key < 0 ? Math.max(0, collection.length + key) : Math.min(collection.length, key)
            else throw new Error('MVU insert 数组位置必须是整数或 -')
            collection.splice(index, 0, value); log = 'ASSIGNED ' + JSON.stringify(value) + " into '" + label + "' at index " + index + ' ' + suffix
          } else if (record(collection) && (typeof key === 'string' || typeof key === 'number')) {
            checkKey(String(key)); collection[String(key)] = value; log = "ASSIGNED key '" + key + "' with value " + JSON.stringify(value) + " into object '" + label + "' " + suffix
          } else throw new Error('MVU insert 目标不是集合或键无效')
        }
      } else if (type === 'delete') {
        let target = parts
        if (args.length === 2) {
          const collection = get(stat, parts), key = literal(args[1])
          if (Array.isArray(collection)) {
            const index = typeof key === 'number' ? key : collection.findIndex(value => equal(value, key))
            if (!Number.isSafeInteger(index) || index < 0 || index >= collection.length) throw new Error('MVU delete 的数组目标不存在')
            target = [...parts, String(index)]
          } else if (record(collection) && typeof key === 'string') { checkKey(key); target = [...parts, key] }
          else throw new Error('MVU delete 对象只支持字面量键；暂不支持按对象属性序号删除')
        }
        remove(stat, target)
        log = "REMOVED path '" + encodePath(target) + "' " + suffix
        if (Array.isArray(get(stat, target.slice(0, -1)))) logPath = target.slice(0, -1)
      } else if (type === 'move' || type === 'copy') {
        const to = path(args[1]), value = copy(get(stat, parts))
        if (type === 'move' && to.length > parts.length && parts.every((key, index) => to[index] === key)) throw new Error('MVU move 不能把节点移动到自己的子路径')
        if (type === 'move' && equal(parts, to)) continue
        if (type === 'move') remove(stat, parts)
        stat = write(stat, to, value, true); logPath = to
        log = (type === 'move' ? 'MOVED' : 'COPIED') + " path '" + label + "' to '" + encodePath(to) + "' " + suffix
      } else {
        if (!equal(get(stat, parts), literal(args[1]))) throw new Error('MVU JSON Patch test 校验失败')
        continue
      }
      checkMetadata(stat)
      logAt(display, logPath, log); logAt(delta, logPath, log)
      // 每一步都执行总输出预算，防止中间 insert/copy 膨胀后再删除掩盖超量。
      json({ stat_data: stat, display_data: display, delta_data: delta }, OUTPUT)
    }
    return json({ stat_data: stat, display_data: display, delta_data: delta }, OUTPUT) as ReturnType<HelperMvuCommandCodec['apply']>
  }
  return { parse, apply }
}
