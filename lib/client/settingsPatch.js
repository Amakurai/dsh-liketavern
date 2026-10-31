const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
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
