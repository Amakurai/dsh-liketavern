/** 角色正文的乐观并发版本：固定字段顺序，不把脚本库或世界书修订混入正文冲突。 */
import { createHash } from 'node:crypto'
import type { CharacterCard } from '../core/types.js'

export function characterEditRevision(card: CharacterCard): string {
  const fields = ['name', 'description', 'personality', 'scenario', 'firstMes',
    'alternateGreetings', 'mesExample', 'systemPrompt', 'postHistoryInstructions',
    'creatorNotes', 'creator', 'characterVersion', 'tags', 'depthPrompt'] as const
  const content = fields.map(key => card[key] ?? null)
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}
