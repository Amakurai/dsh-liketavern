export declare const EDITOR_DRAFT_MAX_BYTES: number;
export interface EditorDraft {
    value: unknown;
    updatedAt: string;
}
export declare function getEditorDraft(root: string, owner: string, key: string): Promise<EditorDraft | null>;
export declare function saveEditorDraft(root: string, owner: string, key: string, value: unknown): Promise<void>;
export declare function deleteEditorDraft(root: string, owner: string, key: string): Promise<void>;
