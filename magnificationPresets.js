import {MAGNIFICATION_ADVANCED} from './magnificationSettings.js';

export const CURVE_KEYS = ['scale', 'peak-mode', 'peak-pixels', 'compression', 'sharpness',
    'cutoff-enabled', 'cutoff-distance', 'cutoff-softness', 'adaptive-reach', 'reach-response',
    'reach-reference', 'preset-app-gap', 'app-gap', 'spacing-mode', 'spacing-falloff'].map(name => `magnification-${name}`);
const options = MAGNIFICATION_ADVANCED.filter(option => CURVE_KEYS.includes(option.key));
const defaults = Object.fromEntries(options.map(option => [option.key, option.default]));
const preset = (id, label, description, overrides = {}) => ({id, label, description,
    values: {...defaults, ...Object.fromEntries(Object.entries(overrides).map(([name, value]) => [`magnification-${name}`, value]))}});
export const MAGNIFICATION_PRESETS = [
    preset('default', 'Default', 'Balanced 2.5× magnification with normal app gaps.'),
    preset('subtle', 'Subtle', 'Gentle 1.75× growth with a soft, narrow boundary.',
        {scale: 175, compression: 125, 'cutoff-distance': 80, 'cutoff-softness': 30}),
    preset('dock', 'Dock', 'Pronounced 3.25× growth with a broad curve and extra spacing near the cursor.',
        {scale: 325, compression: 80, sharpness: 85, 'cutoff-distance': 128, 'cutoff-softness': 25,
            'preset-app-gap': false, 'app-gap': 10}),
    preset('wide', 'Wide', 'Spread 2.75× magnification across more apps, with diminishing extra gaps.',
        {scale: 275, compression: 55, 'cutoff-distance': 192, 'cutoff-softness': 40,
            'preset-app-gap': false, 'app-gap': 12, 'spacing-mode': 'diminishing', 'spacing-falloff': 150}),
    preset('compact', 'Compact', 'Focused 2.25× growth that narrows further as the bar gets crowded.',
        {scale: 225, compression: 160, 'cutoff-distance': 64, 'cutoff-softness': 35,
            'adaptive-reach': true, 'reach-response': 'more', 'preset-app-gap': false,
            'app-gap': 3, 'spacing-mode': 'diminishing'}),
];
const access = {i: 'int', b: 'boolean', s: 'string'};
const read = settings => Object.fromEntries(options.map(option => [option.key, settings[`get_${access[option.type]}`](option.key)]));
const matches = (a, b) => CURVE_KEYS.every(key => a[key] === b[key]);
const valid = values => values && options.every(option => {
    const value = values[option.key];
    return option.type === 'b' ? typeof value === 'boolean'
        : option.type === 's' ? option.values.includes(value)
        : Number.isInteger(value) && value >= option.min && value <= option.max;
});

// A custom entry is created once when leaving a built-in preset. Further edits,
// including every frame of a graph drag, update that same saved entry.
export function createMagnificationPresets(settings) {
    const saved = () => {
        try {
            const entries = JSON.parse(settings.get_string('magnification-custom-presets'));
            const seen = new Set();
            return Array.isArray(entries) ? entries.filter(entry => {
                if (!entry || !Number.isSafeInteger(entry.number) || entry.number < 1 || seen.has(entry.number) || !valid(entry.values)) return false;
                seen.add(entry.number); return true;
            }).map(entry => ({...entry, source: MAGNIFICATION_PRESETS.some(preset => preset.id === entry.source) ? entry.source : 'default'})) : [];
        } catch {return [];}
    };
    const customEntry = entry => ({...entry, id: `custom-${entry.number}`, label: `Custom ${entry.number}`,
        description: `Derived from ${MAGNIFICATION_PRESETS.find(preset => preset.id === entry.source).label}. Further edits update this entry.`});
    const list = () => [...MAGNIFICATION_PRESETS, ...saved().map(customEntry)];
    const sync = () => {
        const values = read(settings), entries = saved(), activeId = settings.get_string('magnification-active-preset');
        const active = list().find(entry => entry.id === activeId);
        if (active && matches(active.values, values)) return activeId;
        let custom = entries.find(entry => `custom-${entry.number}` === activeId);
        if (custom) custom.values = values;
        else {
            // Existing settings are kept intact on first opening the editor.
            const builtIn = MAGNIFICATION_PRESETS.find(entry => matches(entry.values, values));
            if (builtIn) {settings.set_string('magnification-active-preset', builtIn.id); return builtIn.id;}
            custom = {number: Math.max(0, ...entries.map(entry => entry.number)) + 1,
                source: MAGNIFICATION_PRESETS.some(entry => entry.id === activeId) ? activeId : 'default', values};
            entries.push(custom);
        }
        settings.set_string('magnification-custom-presets', JSON.stringify(entries));
        const id = `custom-${custom.number}`;
        settings.set_string('magnification-active-preset', id); return id;
    };
    const apply = entry => {
        for (const option of options) settings[`set_${access[option.type]}`](option.key, entry.values[option.key]);
        settings.set_string('magnification-active-preset', entry.id);
    };
    const select = id => {
        sync();
        const entry = list().find(item => item.id === id);
        if (entry) apply(entry);
    };
    const resetTarget = () => {
        const id = settings.get_string('magnification-active-preset'), entry = list().find(item => item.id === id);
        return MAGNIFICATION_PRESETS.find(preset => preset.id === (entry?.source ?? id)) ?? MAGNIFICATION_PRESETS[0];
    };
    const canReset = () => !matches(read(settings), resetTarget().values);
    const reset = () => {sync(); apply(resetTarget());};
    const remove = id => {
        const entries = saved(), index = entries.findIndex(entry => `custom-${entry.number}` === id);
        if (index < 0) return false;
        const remaining = entries.filter((_, i) => i !== index).sort((a, b) => a.number - b.number);
        if (settings.get_string('magnification-active-preset') === id) {
            const previous = remaining.filter(entry => entry.number < entries[index].number).at(-1) ?? remaining.at(-1);
            apply(remaining.length ? customEntry(previous)
                : MAGNIFICATION_PRESETS.find(preset => preset.id === entries[index].source));
        }
        settings.set_string('magnification-custom-presets', JSON.stringify(remaining));
        return true;
    };
    return {list, sync, select, remove, reset, canReset};
}
