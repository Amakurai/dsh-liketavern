/** 角色发言条（speech.tsx）界面文案。zh 为键全集源。 */

export const zh = {
  'speech.copied': '已复制消息文本',
  'speech.copyFailed': '复制失败',
  'speech.copy': '复制消息文本',
  'speech.navigationUnavailable': '会话导航暂不可用，请刷新后重试。',
  'speech.swipeStarted': '对话已开始，不能直接切换开场白；请使用楼层分支操作。',
  'speech.cardDataTitle': '卡内临时数据 · 备份与恢复',
  'speech.cardDataNote': '只备份卡片通过变量接口保存的数据，不包含未保存的输入。切换会话或刷新前请生成并复制备份，之后用卡片下方的恢复按钮载入；数据不写入角色资产或剧情记忆。',
  'speech.cardDataBackup': '生成并选中备份',
  'speech.cardDataRestore': '恢复卡内备份',
  'speech.cardDataRestoreDesc': '粘贴此前复制的完整备份。确认后会重新打开此卡面并载入备份，替换当前卡内临时数据；会话消息和剧情记忆不受影响。',
  'speech.cardDataText': '卡内变量备份文本',
  'speech.cardDataFailed': '备份无效或超过 1 MiB，原数据未改动。',
} as const

export const en: Record<keyof typeof zh, string> = {
  'speech.copied': 'Message text copied',
  'speech.copyFailed': 'Copy failed',
  'speech.copy': 'Copy message text',
  'speech.navigationUnavailable': 'Session navigation is unavailable. Refresh and try again.',
  'speech.swipeStarted': 'The conversation has started. Use a message branch action to change its course.',
  'speech.cardDataTitle': 'Temporary card data · backup and restore',
  'speech.cardDataNote': 'Backups contain data saved through the card variable API, excluding unsaved inputs. Copy a backup before switching sessions or refreshing, then use Restore below the card. Character assets and story memory are separate.',
  'speech.cardDataBackup': 'Generate and select backup',
  'speech.cardDataRestore': 'Restore card backup',
  'speech.cardDataRestoreDesc': 'Paste a complete backup. Confirming reopens this card with the backup, replacing its current temporary data. Conversation messages and story memory stay unchanged.',
  'speech.cardDataText': 'Card variable backup text',
  'speech.cardDataFailed': 'Invalid backup or larger than 1 MiB. Existing data was kept.',
}
