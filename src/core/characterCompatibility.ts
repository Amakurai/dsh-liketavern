/**
 * 角色卡导入前的只读兼容报告：只扫描有界文本与已知结构，不编译或执行第三方正则、模板或脚本。
 * 信号表示发现的能力/依赖引用，不证明对应代码会执行，也不保证未发现信号的卡片兼容。
 */
import { isNativeMvuFramework } from './cardScript.js'
import { characterHelperScripts } from './helperScripts.js'
import type { CharacterCard } from './types.js'
import { isRecord } from './guards.js'

export const CHARACTER_COMPATIBILITY_CODES = [
  'cardFields', 'regex', 'templates', 'html', 'scripts', 'invalidScripts', 'nativeMvu', 'customMvu',
  'unsupportedApi', 'parentAccess', 'network', 'externalScript', 'externalMedia', 'vectorLore', 'scanLimit',
] as const
export type CharacterCompatibilityCode = typeof CHARACTER_COMPATIBILITY_CODES[number]
export type CharacterCompatibilityStatus = 'supported' | 'unsupported' | 'review'
export interface CharacterCompatibilityFinding {
  code: CharacterCompatibilityCode
  status: CharacterCompatibilityStatus
  /** 同类信号所在字段/条目数；位置只列有限样本，不传输第三方代码。 */
  count: number
  locations: string[]
}
export interface CharacterCompatibilityReport {
  version: 1
  /** 仅表示静态遍历未碰预算上限，不表示兼容、已执行验证或已检查远端依赖。 */
  complete: boolean
  scannedChars: number
  findings: CharacterCompatibilityFinding[]
}

const MAX_CHARS = 2 * 1024 * 1024
const MAX_STRING = 256 * 1024
const MAX_NODES = 16_384
const MAX_DEPTH = 24
const MAX_LOCATIONS = 3

/** 这些 API 在现有卡面桥中仍明确拒绝；已实现的消息/世界书/脚本库接口不列入。 */
const UNSUPPORTED_API = /\b(?:generate|generateRaw|injectPrompts|uninjectPrompts|createChatMessages|rotateChatMessages|getTavernRegexes|replaceTavernRegexes|getPreset|replacePreset|getCharacter)\s*\(/

export function inspectCharacterCompatibility(card: CharacterCard): CharacterCompatibilityReport {
  const findings = new Map<CharacterCompatibilityCode, CharacterCompatibilityFinding>()
  const report: CharacterCompatibilityReport = { version: 1, complete: true, scannedChars: 0, findings: [] }
  const add = (code: CharacterCompatibilityCode, status: CharacterCompatibilityStatus, path: string, count = 1) => {
    const finding = findings.get(code) ?? { code, status, count: 0, locations: [] }
    finding.count += count
    const location = path.slice(0, 240)
    if (finding.locations.length < MAX_LOCATIONS && !finding.locations.includes(location)) finding.locations.push(location)
    findings.set(code, finding)
  }
  const limit = () => { report.complete = false }
  add('cardFields', 'supported', 'card')
  if (card.regexScripts.length) add('regex', 'supported', 'regexScripts', card.regexScripts.length)

  // 不将 raw 重扫一遍，避免原卡与归一化字段重复报告。迭代遍历限制深度和总节点数。
  const sources: Record<string, unknown> = {
    description: card.description, personality: card.personality, scenario: card.scenario,
    firstMes: card.firstMes, alternateGreetings: card.alternateGreetings, mesExample: card.mesExample,
    systemPrompt: card.systemPrompt, postHistoryInstructions: card.postHistoryInstructions,
    creatorNotes: card.creatorNotes, depthPrompt: card.depthPrompt, regexScripts: card.regexScripts,
    characterBook: card.characterBook?.entries, extensions: card.extensions,
  }
  const visited = new WeakSet<object>()
  // card.regexScripts 可能因字段归一化或 JSON 往返与 extensions.regex_scripts 脱离引用共享；
  // 按多重集记录已扫描条目的核心文本指纹，避免同一条规则在两处重复上报。
  const regexScriptKey = (item: Record<string, unknown>): string =>
    JSON.stringify([
      typeof item.findRegex === 'string' ? item.findRegex : null,
      typeof item.replaceString === 'string' ? item.replaceString : null,
    ])
  const scannedRegexCounts = new Map<string, number>()
  for (const script of card.regexScripts) {
    if (!isRecord(script)) continue
    const sig = regexScriptKey(script)
    scannedRegexCounts.set(sig, (scannedRegexCounts.get(sig) ?? 0) + 1)
  }
  let nodes = 0
  const scan = (text: string, path: string, scriptContent: boolean) => {
    const available = Math.min(MAX_STRING, MAX_CHARS - report.scannedChars)
    if (text.length > available) limit()
    const value = text.slice(0, available)
    report.scannedChars += value.length
    if (!value) return
    if (value.includes('<%')) add('templates', 'review', path)
    if (/<(?:!doctype\s+html|html|body|div|script|style|iframe|button|details|table)\b/i.test(value)) add('html', 'review', path)
    const nativeMvu = scriptContent && value.length === text.length && isNativeMvuFramework(value)
    if (!nativeMvu && /MagVarUpdate|\bMvu\s*\.|\bwaitGlobalInitialized\s*\(\s*['"]Mvu['"]/.test(value)) add('customMvu', 'review', path)
    if (UNSUPPORTED_API.test(value)) add('unsupportedApi', 'unsupported', path)
    if (/\b(?:(?:window\s*\.\s*)?(?:parent|top))\s*(?:\.\s*(?:document|SillyTavern|Vue|jQuery|\$)(?![\w$])|\[\s*['"](?:document|SillyTavern|Vue|jQuery|\$)['"]\s*\])/.test(value)) add('parentAccess', 'unsupported', path)
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|\$\s*\.\s*(?:ajax|get|post|getJSON|getScript)\s*\(/.test(value)) add('network', 'review', path)
    if (!nativeMvu && (/<script\b[^>]{0,1024}\bsrc\s*=/i.test(value)
      || /\b(?:import\s*(?:\(\s*)?|from\s*)['"](?:https?:)?\/\//.test(value))) add('externalScript', 'review', path)
    if (/<(?:img|audio|video|source|link)\b[^>]{0,1024}(?:src|href)\s*=\s*['"]?(?:https?:)?\/\//i.test(value)
      || /\burl\(\s*['"]?(?:https?:)?\/\//i.test(value)
      || /!\[[^\]]{0,512}\]\(\s*https?:\/\//i.test(value)) add('externalMedia', 'review', path)
  }
  const visit = (value: unknown, path: string, depth: number, scriptContent = false): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH || report.scannedChars >= MAX_CHARS) { limit(); return }
    if (typeof value === 'string') { scan(value, path, scriptContent); return }
    if (!value || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      const isExtRegexList = path === 'extensions.regex_scripts' || path === 'extensions.regexScripts'
      for (let index = 0; index < value.length; index++) {
        if (nodes >= MAX_NODES || report.scannedChars >= MAX_CHARS) { limit(); break }
        const item = value[index]
        if (isExtRegexList && isRecord(item)) {
          const sig = regexScriptKey(item)
          const remaining = scannedRegexCounts.get(sig) ?? 0
          if (remaining > 0) {
            scannedRegexCounts.set(sig, remaining - 1)
            continue
          }
        }
        visit(item, `${path}[${index}]`, depth + 1)
      }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        if (nodes >= MAX_NODES || report.scannedChars >= MAX_CHARS) { limit(); break }
        const child = (value as Record<string, unknown>)[key]
        // card.depthPrompt 已单独扫描；extensions.depth_prompt 与其同值时去重，避免重复计数与扫描字符。
        // 若 extensions.depth_prompt 含额外厂商字段或与归一化后的 prompt/role 不同，仍进入对象只跳过已扫描的同名同值字段。
        if (card.depthPrompt !== null && path === 'extensions' && key === 'depth_prompt' && isRecord(child)) {
          const samePrompt = child.prompt === card.depthPrompt.prompt
            || ((typeof child.prompt === 'number' || typeof child.prompt === 'boolean') && String(child.prompt) === card.depthPrompt.prompt)
          const sameOrNonStringRole = typeof child.role !== 'string' || child.role === card.depthPrompt.role
          const onlyModeledKeys = Object.keys(child).every((k) => k === 'prompt' || k === 'depth' || k === 'role')
          if (samePrompt && sameOrNonStringRole && onlyModeledKeys) continue
        }
        if (card.depthPrompt !== null && path === 'extensions.depth_prompt') {
          if (key === 'prompt' && child === card.depthPrompt.prompt) continue
          if (key === 'role' && child === card.depthPrompt.role) continue
        }
        // extensions.regex_scripts 与 card.regexScripts 共用对象时由 visited 去重。
        const content = key === 'content' && /^extensions\.(?:tavern_helper|TavernHelper_scripts)(?:\.|\[)/.test(path)
        visit(child, `${path}.${key.slice(0, 64)}`, depth + 1, content)
      }
    }
  }
  for (const [key, value] of Object.entries(sources)) visit(value, key, 0)

  // 世界书向量标记只读取条目及其 extensions，避免把普通剧情变量同名键误报成引擎能力。
  for (const [index, entry] of (card.characterBook?.entries ?? []).slice(0, MAX_NODES).entries()) {
    if (!isRecord(entry)) continue
    const ext = isRecord(entry.extensions) ? entry.extensions : {}
    if (entry.vectorized === true || ext.vectorized === true || isRecord(entry.strategy) && entry.strategy.type === 'vectorized') {
      add('vectorLore', 'unsupported', `characterBook[${index}]`)
    }
  }
  const hasScripts = card.extensions.tavern_helper !== undefined || card.extensions.TavernHelper_scripts !== undefined
  const scriptPath = card.extensions.tavern_helper !== undefined ? 'extensions.tavern_helper' : 'extensions.TavernHelper_scripts'
  if (hasScripts && report.complete) {
    try {
      const trees = characterHelperScripts(card.extensions)
      const scripts = trees.flatMap(tree => tree.type === 'script' ? [tree] : tree.scripts)
      if (scripts.length) add('scripts', 'review', scriptPath, scripts.length)
      // 支持声明只能来自通过实际库解析器的脚本正文，不能由 data.content 等同名字段冒充。
      const nativeCount = scripts.filter(script => isNativeMvuFramework(script.content)).length
      if (nativeCount) add('nativeMvu', 'supported', scriptPath, nativeCount)
    } catch { add('invalidScripts', 'unsupported', scriptPath) }
  } else if (hasScripts) add('scripts', 'review', scriptPath)
  if (!report.complete) add('scanLimit', 'review', 'card')
  const rank = { unsupported: 0, review: 1, supported: 2 }
  report.findings = [...findings.values()].sort((a, b) => rank[a.status] - rank[b.status])
  return report
}
