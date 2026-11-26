const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const OVERLAY_WRITE_PROTECTED_RE = /overridden by a home patch or command-line overlay|(?:home patch|command-line overlay)[^\n]*(?:overrid|read-?only|protect)|overrid[^\n]*(?:home patch|command-line overlay)/i;
/** 识别宿主因命令行 --patch 或主目录配置补丁（home overlay）拒绝保存配置时的错误。 */
export function isSettingsOverlayProtectedError(message) {
    return OVERLAY_WRITE_PROTECTED_RE.test(message);
}
/** 为宿主配置 overlay 写保护错误附加清晰的本地化解释与操作指引，同时保留原始报错文本。 */
export function formatSettingsWriteError(message, translate) {
    if (!isSettingsOverlayProtectedError(message))
        return message;
    return `${translate('settings.overlayWriteProtected')} (${message})`;
}
export function changedSettingsPatch(current, baseline) {
    return Object.fromEntries(Object.entries(current).flatMap(([key, value]) => {
        const previous = object(baseline) && Object.hasOwn(baseline, key) ? baseline[key] : undefined;
        if (JSON.stringify(value) === JSON.stringify(previous))
            return [];
        const changed = object(value) && object(previous) ? changedSettingsPatch(value, previous) : structuredClone(value);
        return [[key, changed]];
    }));
}
export function applySettingsPatch(current, patch) {
    const fields = new Map(Object.entries(current));
    for (const [key, value] of Object.entries(patch)) {
        const previous = fields.get(key);
        fields.set(key, object(value) && object(previous) ? applySettingsPatch(previous, value) : structuredClone(value));
    }
    return Object.fromEntries(fields);
}
