/**
 * 人设解析：会话绑定未指定时，用默认页或「库里只剩一条」接上，避免 {{user}} 落成 User。
 * Persona 数据形状也归这里（纯数据，core 层）；存储在 node/state，remote 契约引用本文件。
 */
import { looseObject, minLength, nullable, optional, string } from 'zod/mini'

/** 无人设时 {{user}} 的展示名（对齐 SillyTavern 缺省 User）。 */
export const DEFAULT_USER_NAME = 'User'

/** 人设（personas/<id>.json）的纯数据形状。 */
export interface Persona {
  id: string
  name: string
  description: string
  /** 头像文件名（personas/<id>.png），无则 null。 */
  avatar: string | null
  /** 挂接的世界书库文件名；空/缺省 = 无人设书。 */
  lorebookId?: string | null
}

const personaSchema = looseObject({
  id: string().check(minLength(1)),
  name: string(),
  description: string(),
  avatar: nullable(string()),
  lorebookId: optional(nullable(string())),
})

/** 人设存储边界：合法 JSON 也要验证字段，避免坏资产进入列表、默认人设解析与提示词。 */
export function parsePersona(value: unknown): Persona {
  return personaSchema.parse(value)
}

/**
 * 绑定指定 > 默认页 > 库里只剩一条。
 * 绑定为空且库里有多条、默认也未选时返回 null（调用方回退展示名 User）。
 */
export function pickPersona<T>(bound: T | null, fallback: T | null, all: T[]): T | null {
  if (bound) return bound
  if (fallback) return fallback
  return all.length === 1 ? all[0]! : null
}
