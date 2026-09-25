/** 新宿主消息角色边界：工具结果和开发者指令不能成为剧情台词或占据模板消息下标。 */
import { expect, it } from 'vitest'
import { createUserMessage, createAssistantMessage, createDeveloperMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { flattenMessages } from '../src/node/pipeline.js'
import { buildTemplateMessageHistory } from '../src/node/templateMessageHistory.js'

it('工具与 developer 文本不污染聊天检索、角色名或模板变量身份', () => {
  const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '去港口' }] })
  const answer = createAssistantMessage({ source: { provider: 'factory', model: 'factory' }, content: [{ type: 'text', text: '到了' }] })
  const messages = [user,
    createToolResultMessage({ callId: ToolCallId('lookup'), content: [{ type: 'text', text: '内部检索结果' }], isError: false }),
    createDeveloperMessage({ source: { kind: 'factory' }, content: [{ type: 'text', text: '开发者指令' }] }), answer]
  const expected = [{ role: 'user', name: 'Bob', content: '去港口' }, { role: 'assistant', name: 'Alice', content: '到了' }]
  expect(flattenMessages(messages, 'Alice', 'Bob')).toEqual(expected)
  const template = buildTemplateMessageHistory(messages, [], 'Alice', 'Bob')
  expect(template.history).toEqual(expected)
  expect(template.identities.map(item => item.messageId)).toEqual([user.id, answer.id])
})
