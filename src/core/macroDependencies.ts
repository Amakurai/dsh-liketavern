/**
 * 一次提示词组装中的宏变量来源追踪。只分析文本，不展开宏或执行模板；变量值仍由
 * expandMacros 按原顺序写入。动态来源写入的变量及其传递读取归入本轮通道，纯静态
 * set/get 保留前缀缓存；后续独立的静态赋值可以恢复该变量的稳定性。
 */
import { hasTurnLocalMacros } from './macros.js'
import type { MacroContext } from './types.js'

/** 可能在任意一轮命中的来源；正文保持引用，不复制世界书资产。 */
export interface MacroDependencySource {
  text: string
  turnLocal: boolean
}

const READ_VAR_RE = /\{\{\s*(?:(?:get|has)(?:local|global)?var|(?:global)?varexists)\s*::([^{}]*)(?=\{\{|\}\})/gi
const WRITE_VAR_RE = /\{\{\s*(set|add|inc|dec|delete|flush)(?:local|global)?var\s*::([^{}]*?)(?=::|\{\{|\}\})/gi
const FIELD_REF_RE = /\{\{\s*([^{}:]+?)\s*\}\}|<(USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/gi
const contextFieldsCache = new WeakMap<MacroContext, Record<string, string | undefined>>()

function fieldsForContext(context: MacroContext): Record<string, string | undefined> {
  let fields = contextFieldsCache.get(context)
  if (!fields) {
    fields = {
      ...context.vars,
      char: context.char, charname: context.char, user: context.user, username: context.user,
      description: context.description, personality: context.personality, scenario: context.scenario,
      chardescription: context.description, charpersonality: context.personality, charscenario: context.scenario,
      charversion: context.charVersion, charcreatornotes: context.creatorNotes, creatornotes: context.creatorNotes,
      chardepthprompt: context.charDepthPrompt, mesexamples: context.mesExamples, mesexamplesraw: context.mesExamples,
      persona: context.persona, firstmessage: context.firstMessage, charfirstmessage: context.firstMessage, greeting: context.firstMessage,
      charprompt: context.charPrompt, charinstruction: context.charInstruction, charjailbreak: context.charInstruction,
      group: context.char, groupnotmuted: context.char, notchar: context.user,
    }
    contextFieldsCache.set(context, fields)
  }
  return fields
}

const EMPTY_SET: ReadonlySet<string> = new Set()

interface StaticMacroScan {
  turnLocal: boolean
  reads: string[]
  computedRead: boolean
  writes: string[]
  computedWrite: boolean
  mutatedReads: string[]
  fieldRefs: string[]
}

const STATIC_SCAN_EMPTY: StaticMacroScan = {
  turnLocal: false, reads: [], computedRead: false, writes: [], computedWrite: false, mutatedReads: [], fieldRefs: [],
}

function scanStaticMacroChunk(text: string): StaticMacroScan {
  if (!text.includes('{{') && !text.includes('<')) return STATIC_SCAN_EMPTY
  const reads: string[] = []
  const writes: string[] = []
  const mutatedReads: string[] = []
  const fieldRefs: string[] = []
  let computedRead = false
  let computedWrite = false
  const turnLocal = hasTurnLocalMacros(text)
  if (text.includes('{{')) {
    for (const match of text.matchAll(READ_VAR_RE)) {
      const key = match[1]!.trim()
      const computed = text.slice(match.index + match[0].length, match.index + match[0].length + 2) === '{{'
      reads.push(key)
      if (computed) computedRead = true
    }
    for (const match of text.matchAll(WRITE_VAR_RE)) {
      const key = match[2]!.trim()
      const computed = text.slice(match.index + match[0].length, match.index + match[0].length + 2) === '{{'
      if (computed) computedWrite = true
      else if (key) {
        writes.push(key)
        const op = match[1]!.toLowerCase()
        if (op !== 'set' && op !== 'delete' && op !== 'flush') mutatedReads.push(key)
      }
    }
  }
  for (const match of text.matchAll(FIELD_REF_RE)) {
    fieldRefs.push((match[1] ?? (match[2]!.toLowerCase() === 'user' ? 'user' : 'char')).trim().toLowerCase())
  }
  return { turnLocal, reads, computedRead, writes, computedWrite, mutatedReads, fieldRefs }
}

export function createMacroDependencyTracker(initial: MacroContext, potentialSources: readonly MacroDependencySource[] = []): {
  isDynamic(text: string, context: MacroContext): boolean
  record(text: string, context: MacroContext, turnLocal: boolean): void
} {
  // 调用方提供的变量没有静态资产来源保证，不能作为跨轮稳定值。
  const dynamicVariables = new Set(initial.store?.keys())
  // 潜在的条件写入不能因当前未命中或默认值赋值而清除，否则首轮会钉死空/default。
  const potentialVariables = new Set<string>()
  let unknownDynamicWrite = false
  const scanCache = new Map<string, StaticMacroScan>()
  const getScan = (text: string): StaticMacroScan => {
    let cached = scanCache.get(text)
    if (!cached) {
      cached = scanStaticMacroChunk(text)
      scanCache.set(text, cached)
    }
    return cached
  }

  const inspect = (text: string, context: MacroContext): { dynamic: boolean; reads: ReadonlySet<string>; writes: ReadonlySet<string>; unknownWrite: boolean } => {
    if (!text.includes('{{') && !text.includes('<')) {
      return { dynamic: false, reads: EMPTY_SET, writes: EMPTY_SET, unknownWrite: false }
    }
    const reads = new Set<string>()
    const writes = new Set<string>()
    let dynamic = false
    let unknownWrite = false
    let fields: Record<string, string | undefined> | undefined
    const pending = [text]
    let visited: Set<string> | undefined
    while (pending.length > 0) {
      const current = pending.pop()!
      if (!current.includes('{{') && !current.includes('<')) continue
      const scanned = getScan(current)
      if (scanned.turnLocal) dynamic = true
      if (scanned.computedRead) dynamic = true
      if (scanned.computedWrite) unknownWrite = true
      for (const key of scanned.reads) {
        reads.add(key)
        if (!dynamic && (unknownDynamicWrite || dynamicVariables.has(key) || potentialVariables.has(key))) dynamic = true
      }
      for (const key of scanned.writes) writes.add(key)
      for (const key of scanned.mutatedReads) {
        reads.add(key)
        if (!dynamic && (unknownDynamicWrite || dynamicVariables.has(key) || potentialVariables.has(key))) dynamic = true
      }
      // 字段与 original 可以继续引用字段或变量。每个名称只访问一次，循环不递归展开。
      if (scanned.fieldRefs.length > 0) {
        fields ??= fieldsForContext(context)
        visited ??= new Set()
        for (const name of scanned.fieldRefs) {
          if (visited.has(name) || !Object.hasOwn(fields, name)) continue
          visited.add(name)
          if (fields[name]) pending.push(fields[name])
        }
      }
    }
    return { dynamic, reads, writes, unknownWrite }
  }

  // 所有候选来源只解析一次。通过变量→读取来源的反向边传播，条目是否在当前轮命中
  // 不改变 standing 的成员；独立的静态预设变量不会被一起降为动态。
  const candidates = potentialSources.map(source => ({ ...inspect(source.text, initial), turnLocal: source.turnLocal }))
  const readers = new Map<string, number[]>()
  for (const [index, candidate] of candidates.entries()) {
    for (const key of candidate.reads) {
      const list = readers.get(key) ?? []
      list.push(index)
      readers.set(key, list)
    }
  }
  const pending = candidates.flatMap((candidate, index) => candidate.turnLocal || candidate.dynamic ? [index] : [])
  const propagated = new Set<number>()
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const index = pending[cursor]!
    if (propagated.has(index)) continue
    propagated.add(index)
    const candidate = candidates[index]!
    if (candidate.unknownWrite && !unknownDynamicWrite) {
      unknownDynamicWrite = true
      candidates.forEach((value, reader) => { if (value.reads.size) pending.push(reader) })
    }
    for (const key of candidate.writes) {
      if (potentialVariables.has(key)) continue
      potentialVariables.add(key)
      pending.push(...(readers.get(key) ?? []))
    }
  }

  return {
    isDynamic: (text, context) => inspect(text, context).dynamic,
    record: (text, context, turnLocal) => {
      const dependencies = inspect(text, context)
      // 计算出来的变量名在不执行宏的前提下不可知，后续读取保守使用本轮上下文。
      if (dependencies.unknownWrite) unknownDynamicWrite = true
      for (const key of dependencies.writes) {
        if (turnLocal || dependencies.dynamic) dynamicVariables.add(key)
        else dynamicVariables.delete(key)
      }
    },
  }
}
