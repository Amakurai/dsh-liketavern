/** 设置面板一级页签（panel/index.tsx）界面文案。zh 为键全集源。 */

export const zh = {
  'panel.tab.characters': '角色',
  'panel.tab.presets': '预设',
  'panel.tab.lorebooks': '世界书',
  'panel.tab.personas': '用户',
  'panel.tab.regex': '正则',
  'panel.tab.memory': '记忆',
  'panel.tab.settings': '设置',
} as const

export const en: Record<keyof typeof zh, string> = {
  'panel.tab.characters': 'Characters',
  'panel.tab.presets': 'Presets',
  'panel.tab.lorebooks': 'Lorebooks',
  'panel.tab.personas': 'User',
  'panel.tab.regex': 'Regex',
  'panel.tab.memory': 'Memory',
  'panel.tab.settings': 'Settings',
}
