/** 角色模板的数据快照：提供 ST 常用根字段与 data 字段，只复制角色资产，不携带 PNG 或内部存储记录。 */
import type { CharacterCard } from './types.js'

export function templateCardData(card:CharacterCard):Record<string,unknown> {
  const extensions={...card.extensions}
  if(card.depthPrompt) extensions.depth_prompt={...card.depthPrompt}
  else delete extensions.depth_prompt
  const data={name:card.name,description:card.description,personality:card.personality,scenario:card.scenario,
    first_mes:card.firstMes,mes_example:card.mesExample,alternate_greetings:card.alternateGreetings,
    system_prompt:card.systemPrompt,post_history_instructions:card.postHistoryInstructions,
    creator_notes:card.creatorNotes,creator:card.creator,character_version:card.characterVersion,tags:card.tags,
    extensions,character_book:card.characterBook?.raw ?? (card.characterBook ? {name:card.characterBook.name,entries:card.characterBook.entries} : null)}
  return structuredClone({...data,creatorcomment:card.creatorNotes,data})
}
