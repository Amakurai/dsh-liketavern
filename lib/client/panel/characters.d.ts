import type { TavernRemote } from '../types.js';
/** 详情页只读交互卡预览：缓存 srcDoc 并在宿主切换明暗主题时实时同步 `setColorScheme`。 */
export declare function CharacterInteractivePreview(props: {
    html: string;
    firstMes: string;
    alternateGreetings: string[];
    name?: string;
    macroName?: string;
    title: string;
}): import("react").JSX.Element;
export declare function CharactersSection(props: {
    remote: TavernRemote;
}): import("react").JSX.Element;
