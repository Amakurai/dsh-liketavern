import type { WorldInfoEntry } from '../../core/types.js';
import type { Envelope } from '../types.js';
export type LorebookTarget = {
    kind: 'library';
    name: string;
} | {
    kind: 'character';
    cardId: string;
    name: string;
};
export declare function LorebookEditor(props: {
    target: LorebookTarget;
    entries: WorldInfoEntry[];
    onClose: () => void;
    onSaved: () => void;
    save: (json: unknown) => Promise<Envelope<unknown>>;
}): any;
