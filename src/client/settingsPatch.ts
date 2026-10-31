/** 设置表单的字段补丁与草稿合并：只提交实际编辑项，数组整体替换，保留服务器最新的未编辑字段。 */
type Fields = Record<string, unknown>
const object = (value: unknown): value is Fields => value !== null && typeof value === 'object' && !Array.isArray(value)

export function changedSettingsPatch(current: Fields, baseline: unknown): Fields {
  return Object.fromEntries(Object.entries(current).flatMap(([key, value]) => {
    const previous = object(baseline) && Object.hasOwn(baseline, key) ? baseline[key] : undefined
    if (JSON.stringify(value) === JSON.stringify(previous)) return []
    const changed = object(value) && object(previous) ? changedSettingsPatch(value, previous) : structuredClone(value)
    return [[key, changed] as const]
  }))
}

export function applySettingsPatch<T extends object>(current: T, patch: Fields): T {
  const fields = new Map<string, unknown>(Object.entries(current))
  for (const [key, value] of Object.entries(patch)) {
    const previous = fields.get(key)
    fields.set(key, object(value) && object(previous) ? applySettingsPatch(previous, value) : structuredClone(value))
  }
  return Object.fromEntries(fields) as T
}
