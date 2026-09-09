import type { HelperSnapshot } from './helperRuntime.js';
export interface CardPersistenceLabels {
    saving: string;
    saved: string;
    failed: string;
    refresh?: string;
}
export declare function installCardPersistence(snapshot: HelperSnapshot, source: string, _labels: CardPersistenceLabels): () => void;
