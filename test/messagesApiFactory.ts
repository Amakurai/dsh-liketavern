/** DeepSeek Messages 协议工厂：仅返回手写 SSE，覆盖正文及工具调用的正常收口。 */
export function messagesResponse(text = '工厂回复', tool?: { id: string; name: string }): Response {
  const frames = [
    { type: 'message_start', message: { id: 'factory-message', role: 'assistant', usage: { input_tokens: 80, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool
      ? { type: 'tool_use', id: tool.id, name: tool.name, input: {} }
      : { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
