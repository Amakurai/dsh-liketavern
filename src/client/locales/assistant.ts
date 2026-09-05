/** assistant 消息排版（assistant.tsx）界面文案。zh 为键全集源。 */

export const zh = {
  'assistant.truncated': '内容已截断（共 {total} 字符）',
  'assistant.thinking': '思考中…',
  'assistant.thought': '思考过程',
  'assistant.characterFallback': '角色',
  'assistant.stopped': '已停止',
  'assistant.unknownBlock': '未知块',
} as const

export const en: Record<keyof typeof zh, string> = {
  'assistant.truncated': 'Content truncated ({total} characters total)',
  'assistant.thinking': 'Thinking…',
  'assistant.thought': 'Reasoning',
  'assistant.characterFallback': 'Character',
  'assistant.stopped': 'Stopped',
  'assistant.unknownBlock': 'Unknown block',
}
