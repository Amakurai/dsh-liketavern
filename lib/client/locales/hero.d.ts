/** 新会话英雄区（hero.tsx）界面文案。zh 为键全集源；en 必须同键齐全（test/i18n.test.ts 校验）。 */
export declare const zh: {
    readonly 'hero.characterFallback': "角色";
    readonly 'hero.loadingCharacters': "加载角色卡…";
    readonly 'hero.creator': "作者 {name}";
    readonly 'hero.start': "开始对话";
    readonly 'hero.prevGreeting': "上一条开场白";
    readonly 'hero.nextGreeting': "下一条开场白";
    readonly 'hero.swipeHint': "← → 切换";
    readonly 'hero.error.emptyGreetingVariant': "当前开场白为空，请先切换变体";
    readonly 'hero.error.noGreetingInput': "该角色没有开场白，请直接在下方输入";
    readonly 'hero.error.enterFailed': "未能写入开场白。会话里已有内容时请直接继续对话。";
    readonly 'hero.detailLoadFailed': "角色详情加载失败。可重新选择角色，或直接在下方输入。";
    readonly 'hero.emptyVariantHint': "当前这条开场白为空，可切换变体。";
    readonly 'hero.noGreetingHint': "该角色没有开场白。可以直接在下方输入。";
    readonly 'hero.pickBook.withCount': "{name}（内嵌世界书 · {count} 条）";
    readonly 'hero.pickBook.noCount': "{name}（内嵌世界书）";
};
export declare const en: Record<keyof typeof zh, string>;
