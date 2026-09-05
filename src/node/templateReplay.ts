/** 沙箱内的阶段切换：重放结束后接入本轮回复输入，变量只接受已验证的同一生成结果。 */
export const TEMPLATE_REPLAY=String.raw`
globalThis.__resumeTemplateReply=context=> {
  if(JSON.stringify(scopes)!==JSON.stringify(context.variables)) throw Error('模板重放变量与已提交状态不一致');
  if(context.messageVariables && !equal(messageSnapshots,context.messageVariables)) throw Error('模板重放消息快照与已提交状态不一致');
  input.phase='render';input.history=context.history;input.model=context.model;
  input.historyIdentities=context.historyIdentities;
  messageIdentities=context.historyIdentities || context.history.map((_,index)=>({messageId:'preview:'+index,swipeId:0}));
  input.renderMessages=context.renderMessages;
  api.runType='render';api.generateType='';
  if(typeof __refreshTemplateContext==='function') __refreshTemplateContext();
};
`;
