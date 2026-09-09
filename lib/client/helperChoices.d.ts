import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { HelperSnapshot } from '../core/helperRuntime.js';
export interface ScriptChoice {
    label: string;
    text: string;
}
export declare function installChoiceInput(resolve: (sessionId: string) => SessionInput | undefined): () => void;
export declare function parseScriptChoices(value: unknown): ScriptChoice[];
export declare function publishScriptChoices(owner: symbol, sessionId: string, context: HelperSnapshot, messageId: number, choices: unknown): void;
export declare function clearScriptChoices(owner: symbol): void;
export declare function choiceDraft(draft: string, text: string, previous: string): string;
export declare function ScriptChoices({ sessionId, context }: {
    sessionId: string;
    context: HelperSnapshot;
}): import("react").JSX.Element | null;
