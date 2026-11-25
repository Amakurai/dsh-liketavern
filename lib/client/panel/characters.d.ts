import type { CharacterDetail, TavernRemote } from '../types.js';
/** 仅提取角色详情弹窗提交给 saveCharacter 的可编辑字段，排除 revision/extensions/spec/characterName 等服务端派生字段。 */
export declare function editableCharacterSnapshot(detail: CharacterDetail): string;
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
