/** 兼容旧版保存的设置草稿；字段与宿主 schema 同名，默认遵循 ST 的卡级提示词偏好。 */
export const DEFAULT_PROMPT_PREFERENCES = {
    preferCharacterPrompt: true,
    preferCharacterInstructions: true,
};
export const EMPTY_SESSION_DEFAULTS = {
    cardId: '',
    presetId: '',
    personaId: '',
    lorebookIds: [],
    characterLorebookId: '',
};
