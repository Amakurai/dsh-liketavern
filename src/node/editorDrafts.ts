/**
 * 编辑器草稿的独立宿主持久层。正文只保存在 Tavern 数据根的 editor-drafts 下，
 * 不进入角色/剧情资产、WAL 或模型可读目录。owner 与 key 都经哈希生成路径；
 * 同一个文件的读写删除共用进程内锁，写入先校验并冻结 JSON，再原子替换。
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from '../state/atomicWrite.js'
import { withWorkspaceLock } from '../state/workspaceLock.js'

export const EDITOR_DRAFT_MAX_BYTES = 2 * 1024 * 1024
const MAX_DEPTH = 128
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export interface EditorDraft {
  value: unknown
  updatedAt: string
}

function invalid(message: string): never {
  throw new Error(`编辑草稿无效：${message}`)
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 不调用 getter/toJSON，不让 JSON.stringify 静默丢弃不支持的字段。 */
function validateValue(value: unknown): asserts value is Record<string, unknown> {
  if (!plainObject(value)) invalid('正文必须是普通对象')
  const active = new WeakSet<object>()
  let budget = 0
  function count(bytes: number): void {
    budget += bytes
    if (budget > EDITOR_DRAFT_MAX_BYTES) invalid('大小不能超过 2 MiB')
  }
  function visit(item: unknown, depth: number): void {
    if (depth > MAX_DEPTH) invalid('嵌套层数过多')
    if (item === null || typeof item === 'boolean') { count(5); return }
    if (typeof item === 'string') { count(Buffer.byteLength(item, 'utf8') + 2); return }
    if (typeof item === 'number' && Number.isFinite(item)) { count(String(item).length); return }
    if (!item || typeof item !== 'object' || (!Array.isArray(item) && !plainObject(item))) invalid('只能包含 JSON 数据')
    if (active.has(item)) invalid('不能包含循环引用')
    if (Object.getOwnPropertySymbols(item).length) invalid('不能包含 Symbol 字段')
    active.add(item)
    count(2)
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Array.isArray(item)) {
      const keys = Object.keys(descriptors).filter((key) => key !== 'length')
      if (keys.length !== item.length) invalid('数组必须连续且不能带额外字段')
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid('数组必须只包含数据元素')
        count(1)
        visit(descriptor.value, depth + 1)
      }
    } else {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (POLLUTION_KEYS.has(key)) invalid('不能包含原型污染字段')
        if (!('value' in descriptor) || !descriptor.enumerable) invalid('对象必须只包含可枚举的数据字段')
        count(Buffer.byteLength(key, 'utf8') + 4)
        visit(descriptor.value, depth + 1)
      }
    }
    active.delete(item)
  }
  visit(value, 0)
}

function draftPath(root: string, owner: string, key: string): string {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(owner)) invalid('浏览器标识格式错误')
  if (typeof key !== 'string' || key.length < 1 || key.length > 300 || key.includes('\0')) invalid('编辑器标识格式错误')
  const hash = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex')
  return join(root, 'editor-drafts', hash(owner), `${hash(key)}.json`)
}

export async function getEditorDraft(root: string, owner: string, key: string): Promise<EditorDraft | null> {
  const path = draftPath(root, owner, key)
  return withWorkspaceLock(path, async () => {
    let file
    try { file = await open(path, 'r') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const size = (await file.stat()).size
      if (size > EDITOR_DRAFT_MAX_BYTES) invalid('已保存草稿大小超过 2 MiB')
      // 有界读取同时覆盖外部进程在 stat 之后扩写文件的情形。
      const bytes = Buffer.alloc(Math.min(size + 1, EDITOR_DRAFT_MAX_BYTES + 1))
      let offset = 0
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset)
        if (result.bytesRead === 0) break
        offset += result.bytesRead
      }
      if (offset > size) invalid('读取期间草稿文件发生变化')
      let record: unknown
      try { record = JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown } catch { invalid('已保存草稿损坏') }
      if (!plainObject(record) || record.version !== 1 || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) invalid('已保存草稿格式错误')
      validateValue(record.value)
      return { value: record.value, updatedAt: record.updatedAt }
    } finally { await file.close() }
  })
}

export async function saveEditorDraft(root: string, owner: string, key: string, value: unknown): Promise<void> {
  const path = draftPath(root, owner, key)
  validateValue(value)
  const serialized = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), value })
  if (Buffer.byteLength(serialized, 'utf8') > EDITOR_DRAFT_MAX_BYTES) invalid('大小不能超过 2 MiB')
  await withWorkspaceLock(path, () => atomicWrite(path, serialized))
}

export async function deleteEditorDraft(root: string, owner: string, key: string): Promise<void> {
  const path = draftPath(root, owner, key)
  await withWorkspaceLock(path, () => rm(path, { force: true }))
}
