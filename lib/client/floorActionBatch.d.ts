import { type FloorActionStateItem } from '../remote.js';
import type { Envelope, TavernRemote } from './types.js';
type FloorStateRequest = {
    sessionId: string;
    messageId: string;
};
export declare function floorActionStateBatched(remote: TavernRemote, request: FloorStateRequest): Promise<Envelope<FloorActionStateItem>>;
export {};
