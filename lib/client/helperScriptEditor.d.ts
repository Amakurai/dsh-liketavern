import { type HelperScriptLibrary, type HelperScriptAsset } from '../core/helperScripts.js';
import type { TavernRemote } from './types.js';
type ScriptEditorProps = {
    label?: string;
    remote: TavernRemote;
    library: HelperScriptLibrary | HelperScriptAsset;
    onClose: () => void;
    onSaved: () => void;
};
export declare function HelperScriptEditor(props: ScriptEditorProps): import("react").JSX.Element;
export declare function HelperScriptEditorBody(props: ScriptEditorProps): import("react").JSX.Element;
export {};
