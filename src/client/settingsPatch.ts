/** 设置表单的字段补丁、草稿合并与宿主写保护错误格式化：只提交实际编辑项，数组整体替换，保留服务器最新的未编辑字段。 */
type Fields = Record<string, unknown>
const object = (value: unknown): value is Fields => value !== null && typeof value === 'object' && !Array.isArray(value)

const OVERLAY_WRITE_PROTECTED_RE = /overridden by a home patch or command-line overlay|(?:home patch|command-line overlay)[^\n]*(?:overrid|read-?only|protect)|overrid[^\n]*(?:home patch|command-line overlay)/i

/** 识别宿主因命令行 --patch 或主目录配置补丁（home overlay）拒绝保存配置时的错误。 */
export function isSettingsOverlayProtectedError(message: string): boolean {
  return OVERLAY_WRITE_PROTECTED_RE.test(message)
}

/** 为宿主配置 overlay 写保护错误附加清晰的本地化解释与操作指引，同时保留原始报错文本。 */
export function formatSettingsWriteError(
  message: string,
  translate: (key: 'settings.overlayWriteProtected') => string,
): string {
  if (!isSettingsOverlayProtectedError(message)) return message
  return `${translate('settings.overlayWriteProtected')} (${message})`
}

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
