import type { TavernRemote } from './types.js';
export declare function rememberCharacter(remote: TavernRemote, cardId: string): void;
export declare function CharacterPicker(props: {
    remote: TavernRemote;
    selectedId?: string;
    busy: boolean;
    error: string | null;
    onPick: (id: string) => void;
    onClose: () => void;
}): import("react").JSX.Element;
