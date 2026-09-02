/** 角色发言条（speech.tsx）界面文案。zh 为键全集源。 */

export const zh = {
  'speech.copied': '已复制消息文本',
  'speech.copyFailed': '复制失败',
  'speech.copy': '复制消息文本',
} as const

export const en: Record<keyof typeof zh, string> = {
  'speech.copied': 'Message text copied',
  'speech.copyFailed': 'Copy failed',
  'speech.copy': 'Copy message text',
}
