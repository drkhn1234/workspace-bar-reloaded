// Run with GSETTINGS_BACKEND=memory gjs -m tests/defaults-check.mjs.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {DEFAULT_CONFIGURATION} from '../defaultConfiguration.js';
import {MAGNIFICATION_ADVANCED, migrateMagnificationSettings, readMagnificationOptions, sizePreset} from '../magnificationSettings.js';
import {migrateGestureSettings} from '../gestures.js';
import {createMagnificationPresets} from '../magnificationPresets.js';

if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw new Error('Requires memory settings');
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const source = Gio.SettingsSchemaSource.new_from_directory(`${root}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.workspace-bar', false)});
let count = 0;
const check = (name, valid) => {if (!valid) throw new Error(name); count++;};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const [key, value] of Object.entries(DEFAULT_CONFIGURATION))
    check(`schema default: ${key}`, equal(settings.get_default_value(key).deep_unpack(), value));
check('Left Margin is absent', !settings.settings_schema.has_key('left-margin'));
check('new app middle-click default', settings.get_string('gesture-app-middle-click') === 'new-instance');
migrateGestureSettings(settings);
migrateMagnificationSettings(settings, sizePreset(settings.get_string('size-mode')));
for (const [key, value] of Object.entries(DEFAULT_CONFIGURATION))
    check(`fresh migration preserves: ${key}`, equal(settings.get_value(key).deep_unpack(), value));
for (const option of MAGNIFICATION_ADVANCED)
    check(`section reset matches schema: ${option.key}`, equal(option.default, settings.get_default_value(option.key).deep_unpack()));
const presets = createMagnificationPresets(settings);
check('fresh curve remains Default without creating a custom preset', presets.sync() === 'default'
    && settings.get_string('magnification-custom-presets') === '[]');
check('fresh curve has nothing to reset', !presets.canReset());
for (const size of ['small', 'medium', 'large']) {
    const preset = sizePreset(size);
    check(`automatic number spacing uses the ${size} preset gutter`, readMagnificationOptions(settings, preset).numberGap === preset.iconSpacing);
}
settings.set_boolean('magnification-preset-number-gap', false);
settings.set_int('magnification-number-gap', 0);
check('custom number spacing can still be zero', readMagnificationOptions(settings, sizePreset('large')).numberGap === 0);
print(`${count} factory default and reset checks passed`);
