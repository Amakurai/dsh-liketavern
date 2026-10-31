export { EDITOR_DRAFT_MAX_BYTES } from '../core/editorDraftLimits.js';
export interface EditorDraft {
    value: unknown;
    updatedAt: string;
}
export declare function getEditorDraft(root: string, owner: string, key: string): Promise<EditorDraft | null>;
export declare function saveEditorDraft(root: string, owner: string, key: string, value: unknown): Promise<void>;
export declare function deleteEditorDraft(root: string, owner: string, key: string): Promise<void>;
