export function matchesCharacterSearch(card, query) {
    const needle = query.trim().toLowerCase();
    if (!needle)
        return true;
    return [card.name, card.characterBookName ?? '', card.creator ?? '', ...(card.tags ?? [])]
        .some((value) => value.toLowerCase().includes(needle));
}
