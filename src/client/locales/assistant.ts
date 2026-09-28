/** assistant 消息排版（assistant.tsx）界面文案。zh 为键全集源。 */

export const zh = {
  'assistant.truncated': '内容已截断（共 {total} 字符）',
  'assistant.thinking': '思考中…',
  'assistant.thought': '思考过程',
  'assistant.characterFallback': '角色',
  'assistant.stopped': '已停止',
  'assistant.unknownBlock': '未知块',
  'assistant.bindingLoadFailed': '角色卡信息暂时无法加载：{message}',
  'assistant.retryBinding': '重新加载角色卡',
  'trigger.continue': '↪ 接着上一条回复续写',
  'trigger.tavern': '↪ Tavern 自动操作',
  'trigger.external': '收到外部请求，触发了本轮回复',
} as const

export const en: Record<keyof typeof zh, string> = {
  'assistant.truncated': 'Content truncated ({total} characters total)',
  'assistant.thinking': 'Thinking…',
  'assistant.thought': 'Reasoning',
  'assistant.characterFallback': 'Character',
  'assistant.stopped': 'Stopped',
  'assistant.unknownBlock': 'Unknown block',
  'assistant.bindingLoadFailed': 'Character information could not be loaded: {message}',
  'assistant.retryBinding': 'Reload character',
  'trigger.continue': '↪ Continuing the previous reply',
  'trigger.tavern': '↪ Tavern automatic action',
  'trigger.external': 'An external request started this reply',
}
