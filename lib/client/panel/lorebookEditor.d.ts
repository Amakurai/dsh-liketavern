import type { WorldInfoEntry } from '../../core/types.js';
import type { Envelope, TavernRemote } from '../types.js';
export type LorebookTarget = {
    kind: 'library';
    name: string;
} | {
    kind: 'character';
    cardId: string;
    name: string;
} | {
    kind: 'chat';
    cardId: string;
    storyId?: string;
    name: string;
};
type LorebookEditorProps = {
    remote?: TavernRemote;
    target: LorebookTarget;
    entries: WorldInfoEntry[];
    onClose: () => void;
    onSaved: () => void;
    save: (json: unknown) => Promise<Envelope<unknown>>;
};
export declare function LorebookEditor(props: LorebookEditorProps): import("react").JSX.Element;
export {};
