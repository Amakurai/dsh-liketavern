function matchesNeedle(card, needle) {
    if (!needle)
        return true;
    return [card.name, card.characterBookName ?? '', card.creator ?? '', ...(card.tags ?? [])]
        .some((value) => value.toLowerCase().includes(needle));
}
export function matchesCharacterSearch(card, query) {
    return matchesNeedle(card, query.trim().toLowerCase());
}
/** 批量筛选只归一化一次查询，避免角色数放大重复的 trim/lowercase。 */
export function filterCharacters(cards, query) {
    const needle = query.trim().toLowerCase();
    return cards.filter((card) => matchesNeedle(card, needle));
}
