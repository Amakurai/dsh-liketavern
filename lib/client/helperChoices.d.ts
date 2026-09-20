import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { HelperDisplayContext, HelperSnapshot } from '../core/helperRuntime.js';
export interface ScriptChoice {
    label: string;
    text: string;
}
export declare function installChoiceInput(resolve: (sessionId: string) => SessionInput | undefined): () => void;
export declare function parseScriptChoices(value: unknown): ScriptChoice[];
export declare function publishScriptChoices(owner: symbol, sessionId: string, context: HelperSnapshot, messageId: number, choices: unknown): void;
export declare function clearScriptChoices(owner: symbol): void;
export declare function choiceDraft(draft: string, text: string, previous: string): string;
type ScriptChoiceContext = Pick<HelperDisplayContext, 'storyId' | 'historyRevision' | 'currentMessageId'>;
interface ScriptChoicesProps {
    sessionId: string;
    context: ScriptChoiceContext;
}
export declare function ScriptChoices(props: ScriptChoicesProps): import("react").JSX.Element;
export {};
