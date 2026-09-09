import type { TavernState } from './state.js';
type Request = {
    sessionId: string;
    storyId: string;
};
export declare const HELPER_MVU_ABANDON_PATH = "state/helper-mvu-abandon.json";
export declare function abandonHelperMvu(state: TavernState, request: Request): Promise<{
    disabled: true;
    abandoned: number;
}>;
export {};
