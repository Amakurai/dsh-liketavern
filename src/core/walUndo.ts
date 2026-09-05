/** 世界状态 JSONL 的条目级逆操作：只撤销本次改变且未被后续编辑的 id，保留其它行。 */
export function undoWorldDelta(before: string | null, after: string | null, current: string | null): string | null {
  const lines = (text: string | null) => (text ?? '').split('\n').filter((line) => line.trim())
  const idOf = (line: string): string | null => {
    try { const row = JSON.parse(line); return typeof row?.id === 'string' ? row.id : null } catch { return null }
  }
  const byId = (text: string | null) => new Map(lines(text).flatMap((line) => {
    const id = idOf(line)
    return id === null ? [] : [[id, line] as const]
  }))
  const previous = byId(before)
  const written = byId(after)
  const actual = byId(current)
  const restore = new Map<string, string | undefined>()
  for (const id of new Set([...previous.keys(), ...written.keys()])) {
    if (previous.get(id) !== written.get(id) && actual.get(id) === written.get(id)) restore.set(id, previous.get(id))
  }
  const result: string[] = []
  for (const line of lines(current)) {
    const id = idOf(line)
    if (id === null || !restore.has(id)) result.push(line)
    else {
      const replacement = restore.get(id)
      if (replacement !== undefined) result.push(replacement)
      restore.delete(id)
    }
  }
  for (const line of restore.values()) if (line !== undefined) result.push(line)
  return result.length ? result.join('\n') + '\n' : before === null ? null : ''
}
