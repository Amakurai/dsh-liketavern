import { type RenderedOutput, type RenderedOutputBatch } from '../remote.js';
import type { Envelope, TavernRemote } from './types.js';
type RenderRequest = {
    sessionId: string;
    text: string;
    messageId?: number;
};
export declare function renderOutputBatched(remote: TavernRemote, request: RenderRequest): Promise<Envelope<RenderedOutput>>;
/** 按引用重组批次结果；声明了共享部分却缺失时该项明确失败，不静默丢掉卡面数据。 */
export declare function expandRenderedOutputBatch(batch: RenderedOutputBatch): Envelope<RenderedOutput>[];
export {};
