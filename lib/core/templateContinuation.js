export function templatePreloadAssets(context) {
    return { char: context.char, user: context.user, card: context.card, entries: context.entries, presets: context.presets,
        charAvatar: context.charAvatar ?? '', userAvatar: context.userAvatar ?? '' };
}
