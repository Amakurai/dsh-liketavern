export function templateCardData(card) {
    const extensions = { ...card.extensions };
    if (card.depthPrompt)
        extensions.depth_prompt = { ...card.depthPrompt };
    else
        delete extensions.depth_prompt;
    const data = { name: card.name, description: card.description, personality: card.personality, scenario: card.scenario,
        first_mes: card.firstMes, mes_example: card.mesExample, alternate_greetings: card.alternateGreetings,
        system_prompt: card.systemPrompt, post_history_instructions: card.postHistoryInstructions,
        creator_notes: card.creatorNotes, creator: card.creator, character_version: card.characterVersion, tags: card.tags,
        extensions, character_book: card.characterBook?.raw ?? (card.characterBook ? { name: card.characterBook.name, entries: card.characterBook.entries } : null) };
    return structuredClone({ ...data, creatorcomment: card.creatorNotes, data });
}
