import assert from 'node:assert/strict';
import test from 'node:test';
import {MAGNIFICATION_ADVANCED} from '../magnificationSettings.js';
import {CURVE_KEYS, createMagnificationPresets} from '../magnificationPresets.js';

function settingsFor(overrides = {}) {
    const values = {...Object.fromEntries(MAGNIFICATION_ADVANCED.map(option => [option.key, option.default])),
        'magnification-active-preset': 'default', 'magnification-custom-presets': '[]', ...overrides};
    const settings = {};
    for (const type of ['int', 'string', 'boolean']) {
        settings[`get_${type}`] = key => values[key];
        settings[`set_${type}`] = (key, value) => {values[key] = value;};
    }
    return {settings, values};
}

test('opening presets preserves existing curve and cutoff choices across reopening', () => {
    const {settings, values} = settingsFor({'magnification-scale': 339, 'magnification-cutoff-enabled': false});
    const before = Object.fromEntries(CURVE_KEYS.map(key => [key, values[key]]));
    assert.equal(createMagnificationPresets(settings).sync(), 'custom-1');
    assert.equal(createMagnificationPresets(settings).sync(), 'custom-1');
    assert.deepEqual(Object.fromEntries(CURVE_KEYS.map(key => [key, values[key]])), before);
    assert.equal(JSON.parse(values['magnification-custom-presets']).length, 1);
});

test('continuous editing creates one custom entry and switching preserves each saved curve', () => {
    const {settings, values} = settingsFor();
    const manager = createMagnificationPresets(settings);
    manager.select('dock');
    for (let size = 330; size < 380; size++) {
        settings.set_int('magnification-scale', size); assert.equal(manager.sync(), 'custom-1');
    }
    manager.select('subtle'); settings.set_int('magnification-compression', 130);
    assert.equal(manager.sync(), 'custom-2');
    const reopened = createMagnificationPresets(settings);
    reopened.select('custom-1'); assert.equal(values['magnification-scale'], 379);
    reopened.select('custom-2'); assert.equal(values['magnification-compression'], 130);
    assert.equal(JSON.parse(values['magnification-custom-presets']).length, 2);
});

test('presets keep graph view, node visibility and workspace appearance choices', () => {
    const extras = {'magnification-graph-zoom': 150, 'magnification-example-count': 17,
        'magnification-number-scale': 75, 'magnification-visible-tools': ['shape']};
    const {settings, values} = settingsFor(extras);
    const manager = createMagnificationPresets(settings);
    for (const entry of manager.list()) {
        manager.select(entry.id);
        for (const [key, value] of Object.entries(extras)) assert.deepEqual(values[key], value);
        assert.equal(manager.sync(), entry.id);
    }
});

test('corrupt or incomplete saved presets cannot replace valid current settings', () => {
    for (const saved of ['invalid JSON', '{}', '[null]', '[{"number":1,"values":{}}]']) {
        const {settings, values} = settingsFor({'magnification-custom-presets': saved, 'magnification-scale': 319});
        const manager = createMagnificationPresets(settings);
        assert.equal(manager.sync(), 'custom-1');
        assert.equal(values['magnification-scale'], 319);
        manager.select('default');
        manager.select('custom-1');
        assert.equal(values['magnification-scale'], 319);
    }
});

test('deletion steps to the lower custom number, wraps to the highest and restores the final source', () => {
    const {settings, values} = settingsFor();
    const manager = createMagnificationPresets(settings);
    for (const [id, scale] of [['dock', 319], ['wide', 289], ['subtle', 189], ['compact', 239], ['default', 269]]) {
        manager.select(id); settings.set_int('magnification-scale', scale); manager.sync();
    }
    manager.select('custom-3');
    let active = 'custom-3';
    for (const expected of ['custom-2', 'custom-1', 'custom-5', 'custom-4', 'compact']) {
        assert.equal(manager.remove(active), true);
        assert.equal(manager.sync(), expected);
        active = expected;
    }
    assert.equal(values['magnification-scale'], 225);
    assert.equal(createMagnificationPresets(settings).sync(), 'compact');
    assert.equal(manager.list().filter(entry => entry.number).length, 0);
});

test('Reset Curve restores the recorded source after reopening and repeated edits', () => {
    const {settings, values} = settingsFor({'magnification-graph-zoom': 150, 'magnification-lift': 12});
    const manager = createMagnificationPresets(settings);
    manager.select('subtle'); settings.set_int('magnification-scale', 229); manager.sync();
    settings.set_int('magnification-compression', 140); manager.sync();
    assert.equal(JSON.parse(values['magnification-custom-presets'])[0].source, 'subtle');
    const reopened = createMagnificationPresets(settings); reopened.reset();
    assert.equal(reopened.sync(), 'subtle');
    assert.equal(values['magnification-scale'], 175); assert.equal(values['magnification-compression'], 125);
    assert.equal(values['magnification-graph-zoom'], 150); assert.equal(values['magnification-lift'], 12);
    reopened.select('custom-1'); assert.equal(values['magnification-scale'], 229);
});

test('older custom presets without source history safely reset to Default', () => {
    const {settings, values} = settingsFor({'magnification-scale': 319});
    const manager = createMagnificationPresets(settings); manager.sync();
    const saved = JSON.parse(values['magnification-custom-presets']); delete saved[0].source;
    settings.set_string('magnification-custom-presets', JSON.stringify(saved));
    createMagnificationPresets(settings).reset();
    assert.equal(values['magnification-active-preset'], 'default');
    assert.equal(values['magnification-scale'], 250);
});

test('reset availability follows the source curve without changing saved presets', () => {
    const {settings, values} = settingsFor();
    const manager = createMagnificationPresets(settings);
    for (const id of ['default', 'dock', 'wide']) {
        manager.select(id); assert.equal(manager.canReset(), false);
        settings.set_int('magnification-scale', 319);
        const saved = values['magnification-custom-presets'];
        assert.equal(manager.canReset(), true);
        assert.equal(values['magnification-custom-presets'], saved);
        manager.sync(); assert.equal(manager.canReset(), true);
        manager.reset(); assert.equal(manager.canReset(), false);
    }
    settings.set_int('magnification-lift', 20);
    assert.equal(manager.canReset(), false);
});

test('deleting an inactive custom preserves the current curve and built-in presets cannot be deleted', () => {
    const {settings, values} = settingsFor();
    const manager = createMagnificationPresets(settings);
    settings.set_int('magnification-scale', 319); manager.sync(); manager.select('dock');
    assert.equal(manager.remove('custom-1'), true);
    assert.equal(manager.sync(), 'dock'); assert.equal(values['magnification-scale'], 325);
    assert.equal(manager.remove('default'), false);
    assert.equal(manager.remove('missing'), false);
});
