import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gdk from 'gi://Gdk?version=4.0';
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import {createMagnificationGraph} from './magnificationGraph.js';
import {MAGNIFICATION_ADVANCED, MAGNIFICATION_KEYS, MAGNIFICATION_SECTIONS, migrateMagnificationSettings, sizePreset, peakIconSize, readMagnificationOptions, LIFT_MAX_UNITS, snapLiftUnits, liftUnitsForPixels, liftPixelsForUnits} from './magnificationSettings.js';
import {CURVE_KEYS, createMagnificationPresets} from './magnificationPresets.js';
import {GESTURE_INPUTS, gestureActions, horizontalActions, migrateGestureSettings} from './gestures.js';

function createMagnificationHeader(settings, presets) {
    const row = new Adw.ActionRow({title: 'Hover Magnification', subtitle: 'Magnify the bar when the cursor is over it.'});
    const dropdown = new Gtk.DropDown({name: 'magnification-preset', valign: Gtk.Align.CENTER, width_request: 128});
    dropdown.update_property([Gtk.AccessibleProperty.LABEL], ['Magnification preset']);
    const trash = new Gtk.Button({name: 'delete-magnification-preset', icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER});
    trash.add_css_class('destructive-action'); trash.add_css_class('circular');
    const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER, tooltip_text: 'Hover Magnification'});
    settings.bind('enable-magnification', toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(trash); row.add_suffix(dropdown); row.add_suffix(toggle); row.set_activatable_widget(toggle);
    let updating = false, pending = 0, signal = null, entries = [], labels = '';
    const update = () => {
        updating = true;
        try {
            const id = presets.sync(); entries = presets.list();
            const nextLabels = JSON.stringify(entries.map(entry => entry.label));
            if (nextLabels !== labels) {labels = nextLabels; dropdown.set_model(Gtk.StringList.new(entries.map(entry => entry.label)));}
            const selected = Math.max(0, entries.findIndex(entry => entry.id === id));
            dropdown.set_selected(selected); dropdown.set_tooltip_text(entries[selected].description);
            trash.set_visible(id.startsWith('custom-')); trash.set_tooltip_text(`Delete ${entries[selected].label}`);
        } finally {updating = false;}
    };
    dropdown.connect('notify::selected', () => {
        if (updating || !entries[dropdown.get_selected()]) return;
        updating = true;
        try {presets.select(entries[dropdown.get_selected()].id);} finally {updating = false;}
        update();
    });
    trash.connect('clicked', () => {
        updating = true;
        try {presets.remove(settings.get_string('magnification-active-preset'));} finally {updating = false;}
        update();
    });
    row.connect('realize', () => {
        signal = settings.connect('changed', (_settings, key) => {
            if (updating || pending || ![...CURVE_KEYS, 'magnification-active-preset', 'magnification-custom-presets'].includes(key)) return;
            // Coalesce linked controls and entire graph drags into one custom entry.
            pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {pending = 0; update(); return GLib.SOURCE_REMOVE;});
        });
        update();
    });
    row.connect('unrealize', () => {
        if (signal !== null) settings.disconnect(signal); signal = null;
        if (pending) GLib.Source.remove(pending); pending = 0;
        presets.sync();
    });
    update(); return row;
}

function createLiftAdjustment(settings) {
    const adjustment = new Gtk.Adjustment({lower: 0, upper: LIFT_MAX_UNITS, step_increment: 0.5, page_increment: 0.5});
    let syncing = false;
    const normalSize = () => sizePreset(settings.get_string('size-mode')).iconSize;
    const write = units => {
        adjustment.set_value(units);
        settings.set_int('magnification-lift', liftPixelsForUnits(units, normalSize()));
    };
    adjustment.connect('value-changed', () => {
        if (syncing) return;
        syncing = true; write(snapLiftUnits(adjustment.get_value())); syncing = false;
    });
    const sync = () => {
        if (syncing) return;
        syncing = true; write(liftUnitsForPixels(settings.get_int('magnification-lift'), normalSize())); syncing = false;
    };
    settings.connect('changed::magnification-lift', sync); settings.connect('changed::size-mode', sync); sync();
    return adjustment;
}

function createSettingsSection(title, subtitle, content, reset = null) {
    const group = new Adw.PreferencesGroup();
    const row = new Adw.ExpanderRow({title, subtitle});
    row.add_css_class('wsb-settings-section');
    if (reset) {
        reset.set_margin_start(16);
        row.add_suffix(reset);
    }
    content.set_margin_top(16); content.set_margin_bottom(16);
    content.set_margin_start(16); content.set_margin_end(16);
    row.add_row(new Gtk.ListBoxRow({child: content, activatable: false, selectable: false}));
    group.add(row); return {group, row};
}

function addSwitchRow(group, settings, key, title, subtitle) {
    let row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function addSpinRow(group, settings, key, title, subtitle, adjustment) {
    let row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment(adjustment),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function addChoiceRow(group, title, subtitle, labels) {
    const row = new Adw.ActionRow({title, subtitle});
    const dropdown = new Gtk.DropDown({model: Gtk.StringList.new(labels), valign: Gtk.Align.CENTER});
    dropdown.update_property([Gtk.AccessibleProperty.LABEL], [title]);
    row.add_suffix(dropdown); row.set_activatable_widget(dropdown); group.add(row);
    return {row, dropdown};
}

function addColorRow(group, settings, option) {
    const row = new Adw.ActionRow({title: option.title, subtitle: option.subtitle});
    const button = new Gtk.ColorDialogButton({name: option.key, valign: Gtk.Align.CENTER,
        dialog: new Gtk.ColorDialog({title: option.title, with_alpha: false})});
    button.update_property([Gtk.AccessibleProperty.LABEL], [option.title]);
    let updating = false;
    const update = () => {
        const rgba = new Gdk.RGBA();
        if (!rgba.parse(settings.get_string(option.key))) rgba.parse(option.default);
        updating = true; button.set_rgba(rgba); updating = false;
    };
    button.connect('notify::rgba', () => {
        if (updating) return;
        const rgba = button.get_rgba();
        const value = '#' + [rgba.red, rgba.green, rgba.blue].map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('');
        if (settings.get_string(option.key) !== value) settings.set_string(option.key, value);
    });
    settings.connect(`changed::${option.key}`, update); update();
    row.add_suffix(button); row.set_activatable_widget(button); group.add(row);
    return row;
}

// `values` are GSettings enum values in the same order as the visible labels.
function addDropdownRow(group, settings, key, title, subtitle, values, labels) {
    const {row, dropdown} = addChoiceRow(group, title, subtitle, labels);
    let selected = values.indexOf(settings.get_string(key));
    if (selected < 0) {
        // Stored value is not one we know about: fall back to the schema default.
        let fallback = settings.get_default_value(key)?.unpack();
        selected = Math.max(0, values.indexOf(fallback));
    }
    dropdown.set_selected(selected);
    dropdown.connect("notify::selected", () => {
        settings.set_string(key, values[dropdown.get_selected()]);
    });
    settings.connect(`changed::${key}`, () => {
        const next = Math.max(0, values.indexOf(settings.get_string(key)));
        if (dropdown.get_selected() !== next) dropdown.set_selected(next);
    });
    return row;
}

function addPeakRow(group, settings) {
    const row = new Adw.ActionRow({title: 'Peak Size',
        subtitle: 'Maximum icon size. Percent follows the normal size preset; Pixels sets an absolute size.'});
    const units = new Gtk.DropDown({model: Gtk.StringList.new(['Percent', 'Pixels']), valign: Gtk.Align.CENTER});
    const value = new Gtk.SpinButton({adjustment: new Gtk.Adjustment(), numeric: true, valign: Gtk.Align.CENTER, width_chars: 4});
    row.add_suffix(value); row.add_suffix(units); row.set_activatable_widget(units); group.add(row);
    let updating = false;
    const update = () => {
        updating = true;
        const pixels = settings.get_string('magnification-peak-mode') === 'pixels';
        units.set_selected(pixels ? 1 : 0);
        value.set_adjustment(new Gtk.Adjustment({lower: pixels ? 1 : 100, upper: pixels ? 512 : 500,
            step_increment: pixels ? 1 : 10, page_increment: pixels ? 10 : 50,
            value: settings.get_int(pixels ? 'magnification-peak-pixels' : 'magnification-scale')}));
        updating = false;
    };
    units.connect('notify::selected', () => {
        if (updating) return;
        const pixels = units.get_selected() === 1;
        const preset = sizePreset(settings.get_string('size-mode'));
        const peak = peakIconSize(readMagnificationOptions(settings, preset), preset.iconSize);
        if (pixels) settings.set_int('magnification-peak-pixels', peak);
        else settings.set_int('magnification-scale', Math.min(500, Math.max(100, Math.round(peak / preset.iconSize * 100))));
        settings.set_string('magnification-peak-mode', pixels ? 'pixels' : 'relative');
    });
    value.connect('value-changed', () => {
        if (!updating) settings.set_int(settings.get_string('magnification-peak-mode') === 'pixels'
            ? 'magnification-peak-pixels' : 'magnification-scale', value.get_value_as_int());
    });
    for (const key of ['magnification-peak-mode', 'magnification-scale', 'magnification-peak-pixels'])
        settings.connect(`changed::${key}`, update);
    update();
    return row;
}

function addCompressionRow(group, settings) {
    const row = new Adw.ActionRow({title: 'Horizontal Compression c',
        subtitle: 'c in f(cx). 1 keeps the base width; values above 1 narrow the bell and values below 1 widen it. The pixel axis stays fixed.'});
    const value = new Gtk.SpinButton({adjustment: new Gtk.Adjustment({lower: 0.05, upper: 16, step_increment: 0.05, page_increment: 0.25}),
        digits: 2, numeric: true, valign: Gtk.Align.CENTER, width_chars: 4});
    let updating = false;
    const update = () => {updating = true; value.set_value(settings.get_int('magnification-compression') / 100); updating = false;};
    value.connect('value-changed', () => {if (!updating) settings.set_int('magnification-compression', Math.round(value.get_value() * 100));});
    settings.connect('changed::magnification-compression', update); row.add_suffix(value); row.set_activatable_widget(value); group.add(row); update(); return row;
}

function addAutomaticGapRow(group, settings, option, automaticKey) {
    const row = new Adw.ActionRow({title: option.title, subtitle: option.subtitle});
    const mode = new Gtk.DropDown({model: Gtk.StringList.new(['Automatic', 'Custom']), valign: Gtk.Align.CENTER});
    const value = new Gtk.SpinButton({adjustment: new Gtk.Adjustment({lower: option.min, upper: option.max,
        step_increment: option.step, page_increment: 5}), numeric: true, width_chars: 3, valign: Gtk.Align.CENTER});
    settings.bind(option.key, value, 'value', Gio.SettingsBindFlags.DEFAULT);
    let updating = false;
    const update = () => {
        updating = true;
        const automatic = settings.get_boolean(automaticKey);
        mode.set_selected(automatic ? 0 : 1); value.set_visible(!automatic);
        updating = false;
    };
    mode.connect('notify::selected', () => {if (!updating) settings.set_boolean(automaticKey, mode.get_selected() === 0);});
    settings.connect(`changed::${automaticKey}`, update);
    row.add_suffix(value); row.add_suffix(mode); row.set_activatable_widget(mode); group.add(row); update();
    return row;
}

function addWidthModeRow(group, settings) {
    const {row, dropdown} = addChoiceRow(group, 'Compression Mode',
        'Fixed keeps c unchanged. Fewer Icons or More Icons increases c when the shown app count is below or above the reference count.',
        ['Fixed', 'Fewer Icons', 'More Icons']);
    let updating = false;
    const update = () => {
        updating = true;
        dropdown.set_selected(!settings.get_boolean('magnification-adaptive-reach') ? 0
            : settings.get_string('magnification-reach-response') === 'more' ? 2 : 1);
        updating = false;
    };
    dropdown.connect('notify::selected', () => {
        if (updating) return;
        const selected = dropdown.get_selected();
        if (selected) settings.set_string('magnification-reach-response', selected === 2 ? 'more' : 'fewer');
        settings.set_boolean('magnification-adaptive-reach', selected !== 0);
    });
    for (const key of ['magnification-adaptive-reach', 'magnification-reach-response'])
        settings.connect(`changed::${key}`, update);
    update(); return row;
}

function addEmptyNumberRow(group, settings) {
    const {row, dropdown} = addChoiceRow(group, 'Empty Workspace Numbers',
        'Keep empty numbers at normal size, grow only over their own workspace, or let nearby cursor movement enlarge them.',
        ['Normal Size', 'Magnify on Hover', 'Follow Nearby Curve']);
    let updating = false;
    const update = () => {
        updating = true;
        dropdown.set_selected(!settings.get_boolean('magnification-empty-numbers') ? 0
            : settings.get_boolean('magnification-empty-hover-only') ? 1 : 2);
        updating = false;
    };
    dropdown.connect('notify::selected', () => {
        if (updating) return;
        const selected = dropdown.get_selected();
        // Set the hover rule first so the enabled state never exposes the wrong rule.
        if (selected) settings.set_boolean('magnification-empty-hover-only', selected === 1);
        settings.set_boolean('magnification-empty-numbers', selected !== 0);
    });
    for (const key of ['magnification-empty-numbers', 'magnification-empty-hover-only'])
        settings.connect(`changed::${key}`, update);
    update(); return row;
}

// Disable and grey out `row` whenever `parentRow`'s switch is off, so a setting
// that only matters while its parent is on says so visually. set_sensitive()
// alone does not reliably dim an Adwaita row's own title label, so the greying
// is driven explicitly via opacity.
function bindRowToSwitch(row, parentRow) {
    let update = () => {
        let active = parentRow.get_active();
        row.set_sensitive(active);
        row.set_opacity(active ? 1 : 0.5);
    };
    update();
    parentRow.connect("notify::active", update);
}

export default class WorkspaceBarPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        let settings = this.getSettings();
        migrateGestureSettings(settings);
        migrateMagnificationSettings(settings, sizePreset(settings.get_string('size-mode')));
        const presets = createMagnificationPresets(settings);
        const hasChanges = keys => keys.some(key => !settings.get_value(key).equal(settings.get_default_value(key)));
        const magnificationChangeKeys = MAGNIFICATION_KEYS.filter(key => key !== 'enable-magnification');
        const liftAdjustment = createLiftAdjustment(settings);
        window.set_search_enabled(true);
        window.set_default_size(1040, 860);

        let page = new Adw.PreferencesPage({ title: "Workspace Bar", icon_name: 'view-paged-symbolic' });

        let positionGroup = new Adw.PreferencesGroup({
            title: "Position",
            description: "Where the workspace bar sits in the top panel",
        });
        let appearanceGroup = new Adw.PreferencesGroup({
            title: "Appearance",
            description: "How the workspace bar looks",
        });
        let animationGroup = new Adw.PreferencesGroup({
            title: "Animation",
            description: "How the workspace bar reacts to changes",
        });
        let behaviourGroup = new Adw.PreferencesGroup({
            title: "Behaviour",
            description: "How the workspace bar responds to clicks",
        });

        addDropdownRow(positionGroup, settings, "position",
            "Position", "Where to place the workspace bar in the top panel",
            ["left", "center", "right"], ["Left", "Center", "Right"]);

        addSpinRow(positionGroup, settings, "position-index",
            "Position In Box", "0 = first. Higher values move it further along the chosen box.",
            { lower: 0, upper: 20, step_increment: 1, page_increment: 5 });

        addDropdownRow(appearanceGroup, settings, "size-mode",
            "Size", "Controls icon size, font size, spacing, and roundness",
            ["small", "medium", "large"], ["Small", "Medium", "Large"]).set_title_lines(1);

        const toolControls = new Gtk.Box({name: 'magnification-controls', homogeneous: true, spacing: 16, hexpand: true});
        const toolColumns = [0, 1].map(() => new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
            spacing: 16, hexpand: true, valign: Gtk.Align.START}));
        toolColumns.forEach(column => toolControls.append(column));
        const narrow = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 760px')});
        narrow.add_setter(toolControls, 'orientation', Gtk.Orientation.VERTICAL);
        narrow.add_setter(toolControls, 'homogeneous', false);
        window.set_size_request(480, 480); window.add_breakpoint(narrow);
        const toolGroups = new Map();
        for (const name of ['peak', 'compression', 'shape', 'marker', 'cutoff']) {
            const title = {peak: 'Size', compression: 'Width', shape: 'Shape', marker: 'Spacing', cutoff: 'Cutoff'}[name];
            const group = new Adw.PreferencesGroup({title, valign: Gtk.Align.START, hexpand: true}); toolGroups.set(name, group);
            toolColumns[toolGroups.size % 2 ? 0 : 1].append(group);
        }
        const addOption = (group, name) => {
            const option = MAGNIFICATION_ADVANCED.find(item => item.key === `magnification-${name}`);
            const row = addSpinRow(group, settings, option.key, option.title, option.subtitle,
                {lower: option.min, upper: option.max, step_increment: option.step, page_increment: option.step * 5});
            return row;
        };
        addPeakRow(toolGroups.get('peak'), settings);
        addCompressionRow(toolGroups.get('compression'), settings);
        addWidthModeRow(toolGroups.get('compression'), settings);
        const reference = addOption(toolGroups.get('compression'), 'reach-reference');
        const updateReference = () => reference.set_sensitive(settings.get_boolean('magnification-adaptive-reach'));
        settings.connect('changed', updateReference); updateReference();
        addOption(toolGroups.get('shape'), 'sharpness');
        const appGap = MAGNIFICATION_ADVANCED.find(item => item.key === 'magnification-app-gap');
        addAutomaticGapRow(toolGroups.get('marker'), settings, appGap, 'magnification-preset-app-gap');
        const distribution = MAGNIFICATION_ADVANCED.find(item => item.key === 'magnification-spacing-mode');
        const distributionRow = addDropdownRow(toolGroups.get('marker'), settings, distribution.key,
            distribution.title, distribution.subtitle, distribution.values, distribution.labels);
        const falloff = addOption(toolGroups.get('marker'), 'spacing-falloff');
        const updateDistribution = () => {
            const custom = !settings.get_boolean('magnification-preset-app-gap');
            distributionRow.set_sensitive(custom);
            falloff.set_sensitive(custom && settings.get_string('magnification-spacing-mode') === 'diminishing');
            falloff.set_visible(settings.get_string('magnification-spacing-mode') === 'diminishing');
        };
        settings.connect('changed', updateDistribution); updateDistribution();
        addSwitchRow(toolGroups.get('cutoff'), settings, 'magnification-cutoff-enabled',
            'Enable Cutoff', 'Return to normal size and spacing beyond the boundary. Turn off to use the full curve.');
        const cutoffRows = ['cutoff-distance', 'cutoff-softness'].map(name => addOption(toolGroups.get('cutoff'), name));
        const updateCutoff = () => {
            const enabled = settings.get_boolean('magnification-cutoff-enabled');
            for (const row of cutoffRows) {row.set_sensitive(enabled); row.set_opacity(enabled ? 1 : 0.5);}
        };
        settings.connect('changed', updateCutoff); updateCutoff();
        const advancedGroups = new Map();
        for (const [section, [title, description]] of Object.entries(MAGNIFICATION_SECTIONS)) {
            const group = new Adw.PreferencesGroup({title, description});
            const reset = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER,
                tooltip_text: `Restore ${title.toLowerCase()} defaults`});
            const keys = MAGNIFICATION_ADVANCED.filter(item => item.section === section
                && !CURVE_KEYS.includes(item.key) && !['magnification-graph-zoom', 'magnification-graph-span', 'magnification-example-count'].includes(item.key)).map(item => item.key);
            if (section === 'spacing') keys.push('magnification-spacing');
            if (section === 'circle') keys.push('show-active-workspace-ring');
            reset.connect('clicked', () => {for (const key of keys) settings.reset(key);});
            const updateReset = () => reset.set_sensitive(hasChanges(keys));
            settings.connect('changed', updateReset); updateReset();
            group.set_header_suffix(reset);
            advancedGroups.set(section, group);
        }
        addSpinRow(advancedGroups.get('spacing'), settings, 'magnification-spacing',
            'Workspace Group Gap', 'Peak gap between workspaces. App-to-app spacing is edited in the graph.',
            {lower: 0, upper: 64, step_increment: 1, page_increment: 4});
        addSwitchRow(advancedGroups.get('circle'), settings, 'show-active-workspace-ring',
            'Active Workspace Circle', 'Circle the active workspace number in the accent colour while magnified.');
        const optical = new Adw.SwitchRow({title: 'Optical Centring',
            subtitle: 'Align the circle with the digit’s visual centre. Turn off to use the centre of its bounding box.'});
        optical.connect('notify::active', () => {
            if (optical.get_active() !== (settings.get_int('magnification-optical-strength') > 0))
                settings.set_int('magnification-optical-strength', optical.get_active() ? 100 : 0);
        });
        const updateOptical = () => {
            optical.set_active(settings.get_int('magnification-optical-strength') > 0);
            const enabled = settings.get_boolean('show-active-workspace-ring');
            optical.set_sensitive(enabled); optical.set_opacity(enabled ? 1 : 0.5);
        };
        settings.connect('changed::magnification-optical-strength', updateOptical);
        settings.connect('changed::show-active-workspace-ring', updateOptical); updateOptical();
        advancedGroups.get('circle').add(optical);
        const subgroups = new Map();
        const collapsed = (section, name, title, subtitle) => {
            if (!subgroups.has(name)) {
                const row = new Adw.ExpanderRow({title, subtitle});
                row.add_css_class('wsb-settings-section');
                row.add_css_class('wsb-settings-details');
                advancedGroups.get(section).add(row);
                subgroups.set(name, {add: child => row.add_row(child)});
            }
            return subgroups.get(name);
        };
        const skip = new Set(['scale', 'peak-mode', 'peak-pixels', 'compression', 'graph-span', 'graph-zoom', 'sharpness', 'cutoff-enabled', 'cutoff-softness', 'spacing-falloff', 'empty-numbers', 'empty-hover-only', 'vertical-alignment',
            'preset-app-gap', 'preset-number-gap', 'preset-group-minimum', 'cutoff-distance', 'adaptive-reach', 'reach-response', 'reach-reference', 'example-count', 'app-gap', 'spacing-mode',
            'lift', 'optical-strength', 'circle-offset-x', 'circle-offset-y'].map(name => `magnification-${name}`));
        for (const option of MAGNIFICATION_ADVANCED) {
            if (skip.has(option.key)) continue;
            let group = advancedGroups.get(option.section);
            if (option.key.includes('icon-shadow-')) group = collapsed('style', 'icon-shadows', 'App Icon Shadows', 'Adjust shadow darkness, softness and vertical offset.');
            if (option.key.includes('number-shadow-')) group = collapsed('style', 'number-shadows', 'Number Shadows', 'Adjust shadow darkness, softness and vertical offset.');
            const auto = {'magnification-app-gap': 'magnification-preset-app-gap',
                'magnification-number-gap': 'magnification-preset-number-gap',
                'magnification-group-minimum': 'magnification-preset-group-minimum'}[option.key];
            const row = auto ? addAutomaticGapRow(group, settings, option, auto)
                : option.type === 'b' ? addSwitchRow(group, settings, option.key, option.title, option.subtitle)
                : option.type === 'color' ? addColorRow(group, settings, option)
                : option.type === 's' ? addDropdownRow(group, settings, option.key, option.title, option.subtitle, option.values, option.labels)
                : addSpinRow(group, settings, option.key, option.title, option.subtitle,
                    {lower: option.min, upper: option.max, step_increment: option.step, page_increment: option.step * 5});
            const update = () => {
                let enabled = true;
                if (option.section === 'circle') enabled &&= settings.get_boolean('show-active-workspace-ring');
                if (!auto && option.depends) enabled &&= settings.get_boolean(option.depends[0]) === option.depends[1];
                if (option.section === 'highlight' && !['magnification-focus-highlight-enabled', 'magnification-focus-highlight-opacity'].includes(option.key))
                    enabled &&= settings.get_int('magnification-focus-highlight-opacity') > 0;
                if (option.key === 'magnification-focus-highlight-color')
                    row.set_visible(settings.get_string('magnification-focus-highlight-color-mode') === 'custom');
                if (option.key === 'magnification-number-scale') enabled &&= settings.get_string('magnification-number-mode') !== 'none';
                if (option.key === 'magnification-spacing-falloff') enabled &&= settings.get_string('magnification-spacing-mode') === 'diminishing' && !settings.get_boolean('magnification-preset-app-gap');
                if (option.key === 'magnification-easing') enabled &&= settings.get_int('magnification-duration') > 0;
                for (const name of ['icon', 'number'])
                    if (option.key === `magnification-${name}-shadow-blur` || option.key === `magnification-${name}-shadow-offset`)
                        enabled &&= settings.get_int(`magnification-${name}-shadow-opacity`) > 0;
                row.set_sensitive(enabled); row.set_opacity(enabled ? 1 : 0.5);
            };
            settings.connect('changed', update); update();
            if (option.key === 'magnification-number-scale') {
                const empty = addEmptyNumberRow(group, settings);
                const updateEmpty = () => empty.set_sensitive(settings.get_string('magnification-number-mode') !== 'none'
                    && settings.get_int('magnification-number-scale') > 0);
                settings.connect('changed', updateEmpty); updateEmpty();
            }
        }
        const resetAll = () => {
            presets.select('default');
            for (const key of MAGNIFICATION_KEYS) settings.reset(key);
        };

        addSwitchRow(appearanceGroup, settings, "show-icons-background",
            "Show Icons Background", "Draw a subtle fill behind the workspace icons");

        addSwitchRow(appearanceGroup, settings, "legibility-shadows",
            "Legibility Shadows", "Cast a soft shadow behind numbers and icons, and shade a thin rim just outside each pill's border");

        addSwitchRow(appearanceGroup, settings, "dim-inactive-icons",
            "Dim Inactive Icons", "Show every window icon except the focused one at reduced opacity");

        addSwitchRow(appearanceGroup, settings, "desaturate-inactive-icons",
            "Desaturate Inactive Icons", "Show every window icon except the focused one in grayscale");

        addSwitchRow(animationGroup, settings, "enable-animations",
            "Enable Animations",
            "Smoothly animate opening, closing, moving, creating and reordering. Turn off for instant updates.");

        let focusRow = addSwitchRow(animationGroup, settings, "focus-scale-effect",
            "Focus Scale Effect", "Slightly shrink unfocused app icons with a smooth transition");

        // Reduction amount is only meaningful while the effect itself is on.
        let focusAmountRow = addSpinRow(animationGroup, settings, "focus-scale-reduction",
            "Reduction Amount", "Percentage by which unfocused icons are shrunk",
            { lower: 5, upper: 95, step_increment: 1, page_increment: 5 });
        bindRowToSwitch(focusAmountRow, focusRow);

        addSpinRow(behaviourGroup, settings, 'empty-workspace-cooldown',
            'Empty Workspace Cooldown',
            'Seconds to preserve an empty workspace before occupied ones. Placing a window there resets the timer. 0 uses GNOME’s normal cleanup immediately. Dynamic workspaces only.',
            {lower: 0, upper: 3600, step_increment: 5, page_increment: 30});

        addSwitchRow(behaviourGroup, settings, "combine-icons",
            "Combine App Icons",
            "Show one icon with a window-count badge when an app has several windows on a workspace. Click it to pick a window; drag it to move them all at once.");

        const gesturesPage = new Adw.PreferencesPage({title: 'Gestures', icon_name: 'input-touchpad-symbolic'});
        const horizontalGroup = new Adw.PreferencesGroup();
        const switchWorkspaces = addSwitchRow(horizontalGroup, settings, 'gesture-horizontal-switch-workspaces',
            'Horizontal Scroll/Swipe switches workspaces',
            'Switch workspaces wherever you scroll horizontally over the bar. Longer swipes and momentum continue through more workspaces.');
        switchWorkspaces.set_name('gesture-horizontal-switch-workspaces');
        gesturesPage.add(horizontalGroup);
        for (const [kind, title, description] of [
            ['app', 'App Icons', 'Actions apply in both normal and magnified views. A combined icon affects all its windows; a row in its window list affects only that window.'],
            ['workspace', 'Workspace Numbers', 'Actions over a workspace number or its background affect the whole workspace. Move and close actions apply to all its app windows. Overview gestures open or close Overview on this workspace.'],
        ]) {
            const group = new Adw.PreferencesGroup({title, description});
            for (const [input, label] of GESTURE_INPUTS) {
                const horizontal = input === 'horizontal-scroll';
                const actions = horizontal ? horizontalActions(kind) : gestureActions(kind, input);
                const subtitle = horizontal
                    ? 'Swipe left for previous/earlier; right for next/later. Distance and momentum control how many steps are performed.'
                    : input.startsWith('scroll-')
                        ? 'Mouse wheel or two-finger scrolling. Each touchpad scroll gesture performs one action on its starting target.'
                        : input === 'left-click' ? 'Also applies to a touch tap.'
                            : input === 'right-click' ? 'Also applies to a touch long press.' : 'Choose what the middle mouse button does.';
                const key = `gesture-${kind}-${input}`;
                const row = addDropdownRow(group, settings, key, label, subtitle, actions.map(item => item[0]), actions.map(item => item[1]));
                row.set_name(key);
                if (horizontal) {
                    const update = () => row.set_sensitive(!settings.get_boolean('gesture-horizontal-switch-workspaces'));
                    settings.connect('changed::gesture-horizontal-switch-workspaces', update); update();
                }
            }
            gesturesPage.add(group);
        }

        page.add(positionGroup);
        page.add(appearanceGroup);
        const magnificationPage = new Adw.PreferencesPage({title: 'Magnification', icon_name: 'zoom-in-symbolic'});
        const graphGroup = new Adw.PreferencesGroup({title: 'Magnification Editor',
            description: 'Toggle graph nodes and drag them to edit. Expand Advanced Settings → Curve for numeric controls. The icons use the same dimensions and spacing as the magnified bar. At 100%, the preview is actual size.'});
        const reset = new Gtk.Button({name: 'reset-magnification', label: 'Reset Curve', valign: Gtk.Align.CENTER,
            tooltip_text: 'Restore the source preset this custom curve was derived from'});
        reset.connect('clicked', () => {
            if (settings.get_boolean('show-advanced-magnification')) resetAll();
            else presets.reset();
        });
        const previewControls = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, halign: Gtk.Align.START});
        previewControls.add_css_class('wsb-preview-controls');
        const example = new Adw.SpinRow({name: 'magnification-example-count', title: 'Icons:',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 31, step_increment: 1, page_increment: 4}),
            tooltip_text: 'Number of example icons in this preview only. It does not set the number of app icons in the magnified workspace bar, which uses the apps actually shown.'});
        example.update_property([Gtk.AccessibleProperty.LABEL], ['Example Icon Count']);
        settings.bind('magnification-example-count', example, 'value', Gio.SettingsBindFlags.DEFAULT);
        previewControls.append(example);
        const alignment = new Gtk.DropDown({name: 'magnification-vertical-alignment',
            model: Gtk.StringList.new(['Dock Curve', 'Centre Line']),
            tooltip_text: 'Vertical alignment. Dock Curve anchors icons to the panel edge; Centre Line aligns their centres.'});
        alignment.update_property([Gtk.AccessibleProperty.LABEL], ['Vertical Alignment']);
        const alignments = ['panel-edge', 'center-line'];
        const updateAlignment = () => alignment.set_selected(Math.max(0, alignments.indexOf(settings.get_string('magnification-vertical-alignment'))));
        alignment.connect('notify::selected', () => settings.set_string('magnification-vertical-alignment', alignments[alignment.get_selected()]));
        settings.connect('changed::magnification-vertical-alignment', updateAlignment); updateAlignment();
        const placementControls = new Gtk.Box({spacing: 24, valign: Gtk.Align.CENTER});
        const liftControls = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
        liftControls.append(new Gtk.Label({label: 'Lift'}));
        const lift = new Gtk.Scale({name: 'magnification-lift-slider', orientation: Gtk.Orientation.HORIZONTAL,
            draw_value: false, width_request: 210, valign: Gtk.Align.CENTER, adjustment: liftAdjustment});
        lift.set_round_digits(1); lift.update_property([Gtk.AccessibleProperty.LABEL], ['Lift from Panel']);
        lift.add_css_class('wsb-lift-slider');
        for (let value = 0; value <= LIFT_MAX_UNITS; value += 0.5)
            lift.add_mark(value, Gtk.PositionType.BOTTOM, Number.isInteger(value) ? `<b>${value ? `+${value}×` : '0'}</b>` : null);
        const updateLiftTooltip = () => lift.set_tooltip_text(`Lift +${liftAdjustment.get_value()} icon heights (${settings.get_int('magnification-lift')} px)`);
        settings.connect('changed::magnification-lift', updateLiftTooltip); updateLiftTooltip();
        const editorStyle = new Gtk.CssProvider();
        // Adwaita's expanded-row selector also matches arrows in nested rows.
        // Scope collapsed styling to each section's own header instead.
        editorStyle.load_from_string(`
            viewswitcher.wsb-header-tabs button.toggle > stack > box.wide { padding-left: 18px; padding-right: 18px; }
            list.wsb-preview-controls { background-color: transparent; }
            row.wsb-settings-details,
            row.wsb-settings-details > box > list,
            row.wsb-settings-details > box > list > row.header,
            row.wsb-settings-details > box > revealer > list.nested,
            row.wsb-settings-details > box > revealer > list.nested > row { border-radius: 0; }
            .wsb-lift-slider marks label { font-size: 0.8em; }
            .wsb-lift-slider marks mark:nth-child(odd) indicator { min-height: 10px; }
            .wsb-lift-slider marks mark:nth-child(even) indicator { min-height: 5px; }
            #advanced-magnification-settings > box > list > row.header image.expander-row-arrow:dir(ltr) { margin-left: 12px; }
            #advanced-magnification-settings > box > list > row.header image.expander-row-arrow:dir(rtl) { margin-right: 12px; }
            row.wsb-settings-section:not(:checked) > box > list > row.header image.expander-row-arrow {
                -gtk-icon-transform: rotate(0.5turn);
                opacity: var(--dim-opacity);
                color: inherit;
            }
            row.wsb-settings-section:not(:checked):dir(rtl) > box > list > row.header image.expander-row-arrow {
                -gtk-icon-transform: rotate(-0.5turn);
            }
        `);
        Gtk.StyleContext.add_provider_for_display(window.get_display(), editorStyle, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        window.connect('unrealize', () => Gtk.StyleContext.remove_provider_for_display(window.get_display(), editorStyle));
        liftControls.append(lift); placementControls.append(liftControls); placementControls.append(alignment);
        const editor = createMagnificationGraph(settings, {group: graphGroup, previewControls, placementControls,
            headerRow: createMagnificationHeader(settings, presets),
            onPlacementWrapped: wrapped => placementControls.reorder_child_after(alignment, wrapped ? null : liftControls)});
        const advanced = new Adw.ExpanderRow({name: 'advanced-magnification-settings', show_enable_switch: true});
        advanced.update_property([Gtk.AccessibleProperty.LABEL], ['Advanced Settings']);
        // Keep the reset action at the left of the native expander's header, with
        // the label, enable switch and disclosure arrow at the right.
        const actions = new Gtk.Box({spacing: 12, hexpand: true});
        actions.append(reset); actions.append(new Gtk.Box({hexpand: true}));
        advanced.add_prefix(actions); advanced.add_suffix(new Gtk.Label({label: 'Advanced Settings', margin_end: 12}));
        const advancedBody = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 24,
            margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16});
        const resetCurve = new Gtk.Button({name: 'reset-curve', label: 'Reset', valign: Gtk.Align.CENTER,
            tooltip_text: 'Restore the source preset this custom curve was derived from'});
        resetCurve.update_property([Gtk.AccessibleProperty.LABEL], ['Reset Curve']);
        resetCurve.connect('clicked', () => presets.reset());
        const updateCurveReset = () => resetCurve.set_sensitive(presets.canReset());
        settings.connect('changed', updateCurveReset); updateCurveReset();
        const curve = createSettingsSection('Curve', 'Size, width, shape, spacing and cutoff controls.', toolControls, resetCurve);
        curve.row.set_name('curve-settings'); advancedBody.append(curve.group);
        for (const [section, group] of advancedGroups) {
            const title = section === 'size' ? 'Workspace Numbers Scaling' : section === 'circle' ? 'Workspace Circle' : group.get_title();
            const subtitle = section === 'size' ? 'Control how workspace numbers follow their app icons.' : group.get_description();
            const reset = group.get_header_suffix(); group.set_header_suffix(null);
            group.set_title(''); group.set_description(''); reset.set_name(`reset-${section}`);
            reset.set_tooltip_text(`Restore ${title.toLowerCase()} defaults`);
            reset.update_property([Gtk.AccessibleProperty.LABEL], [`Reset ${title}`]);
            const menu = createSettingsSection(title, subtitle, group, reset);
            menu.row.set_name(`advanced-${section}`); advancedBody.append(menu.group);
        }
        advanced.add_row(new Gtk.ListBoxRow({child: advancedBody, activatable: false, selectable: false}));
        settings.bind('show-advanced-magnification', advanced, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
        advanced.set_expanded(advanced.get_enable_expansion());
        const updateAdvanced = () => {
            const enabled = advanced.get_enable_expansion();
            reset.set_label(enabled ? 'Reset All' : 'Reset Curve');
            reset.set_tooltip_text(enabled ? 'Restore defaults for all magnification settings'
                : 'Restore the source preset this custom curve was derived from');
            if (enabled) advanced.set_expanded(true);
        };
        advanced.connect('notify::enable-expansion', updateAdvanced); updateAdvanced();
        const updateReset = () => reset.set_sensitive(settings.get_boolean('show-advanced-magnification')
            ? hasChanges(magnificationChangeKeys) : presets.canReset());
        settings.connect('changed', updateReset); updateReset();
        editor.add(advanced);
        magnificationPage.add(graphGroup);
        page.add(animationGroup);
        page.add(behaviourGroup);
        window.add(page);
        window.add(magnificationPage);
        window.add(gesturesPage);
        // Size header tabs to their contents so shorter labels keep the same
        // padding. Leave the narrow bottom switcher evenly distributed.
        const sizeHeaderTabs = widget => {
            if (widget instanceof Adw.ViewSwitcher && widget.get_policy() === Adw.ViewSwitcherPolicy.WIDE) {
                widget.add_css_class('wsb-header-tabs');
                const layout = widget.get_layout_manager();
                if (layout instanceof Gtk.BoxLayout) layout.set_homogeneous(false);
            }
            for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) sizeHeaderTabs(child);
        };
        sizeHeaderTabs(window);
        // Give the editor room while allowing the page to adapt to smaller windows.
        const widen = widget => {
            if (widget instanceof Adw.Clamp) {widget.set_maximum_size(960); widget.set_tightening_threshold(800);}
            for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) widen(child);
        };
        widen(magnificationPage);
    }
}
