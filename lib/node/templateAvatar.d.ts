import type { Persona } from '../core/persona.js';
import type { TavernState } from './state.js';
export declare function loadTemplateAvatars(state: TavernState, cardId: string, persona: Persona | null): Promise<{
    charAvatar: string;
    userAvatar: string;
}>;
