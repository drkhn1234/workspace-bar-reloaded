// Run with GSETTINGS_BACKEND=memory gjs -m tests/preferences-check.mjs.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const {default: Preferences} = await import(`file://${root}/prefs.js`);
const {MAGNIFICATION_KEYS, readMagnificationOptions, sizePreset, peakIconSize} = await import(`file://${root}/magnificationSettings.js`);
const {magnificationGraphModel, magnificationGraphViewport} = await import(`file://${root}/magnificationGraphModel.js`);
const source = Gio.SettingsSchemaSource.new_from_directory(root + '/schemas', Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.workspace-bar', false)});
if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw new Error('This check requires GSETTINGS_BACKEND=memory');
let failure = null, count = 0;
const check = (name, condition) => {if (!condition) throw new Error(name); count++; print(name);};
const walk = (widget, result = []) => {result.push(widget); for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) walk(child, result); return result;};
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {resolve(); return GLib.SOURCE_REMOVE;}));
const app = new Adw.Application({application_id: 'org.codex.WorkspaceBarPreferencesCheck', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    // Keep interactions deterministic even when the test window is occluded.
    Gtk.Settings.get_default().set_property('gtk-enable-animations', false);
    const window = new Adw.PreferencesWindow({application: app, title: 'Workspace Bar Preferences Check'});
    (async () => {
        // Exercise layout and expansion with an explicit fixture; factory defaults
        // are checked separately by defaults-check.mjs.
        settings.set_string('size-mode', 'medium');
        settings.set_string('position', 'left');
        settings.set_boolean('show-advanced-magnification', false);
        settings.set_strv('magnification-visible-tools', ['peak']);
        settings.set_boolean('gesture-horizontal-switch-workspaces', true);
        settings.set_boolean('gesture-horizontal-natural-scroll', false);
        settings.set_boolean('gesture-horizontal-natural-movement', true);
        settings.set_int('magnification-frame-opacity', 80);
        Preferences.prototype.fillPreferencesWindow.call({getSettings: () => settings}, window);
        check('Workspace Bar is the default view', window.get_visible_page().get_title() === 'Workspace Bar');
        const initialPages = window.get_visible_page().get_parent().get_pages();
        const graphPage = Array.from({length: initialPages.get_n_items()}, (_, i) => initialPages.get_item(i).get_child())
            .find(page => page.get_title() === 'Magnification');
        window.set_visible_page(graphPage);
        window.present(); await delay(300);
        const initialArtifact = GLib.getenv('WSB_PREFERENCES_SCREENSHOT');
        if (initialArtifact) {
            const paintable = new Gtk.WidgetPaintable({widget: window}), snapshot = new Gtk.Snapshot();
            paintable.snapshot(snapshot, window.get_width(), window.get_height());
            window.get_renderer().render_texture(snapshot.to_node(), null).save_to_png(initialArtifact + '-initial.png');
        }
        const widgets = walk(window), rows = widgets.filter(w => w instanceof Adw.PreferencesRow);
        const row = title => rows.find(w => w.get_title() === title);
        check('Left Margin has been removed', !row('Left Margin') && !settings.settings_schema.has_key('left-margin'));
        check('workspace frame opacity is removed and its old value is reset to zero', !row('Workspace Frame Opacity')
            && settings.get_int('magnification-frame-opacity') === 0);
        settings.set_int('magnification-frame-opacity', 100);
        check('legacy frame settings cannot make magnified frames visible', readMagnificationOptions(settings, sizePreset('medium')).frameOpacity === 0);
        settings.reset('magnification-frame-opacity');
        const pages = window.get_visible_page().get_parent().get_pages();
        check('Workspace Bar leads the switcher and Gestures stays third', Array.from({length: pages.get_n_items()}, (_, i) => pages.get_item(i).get_child().get_title()).join(',') === 'Workspace Bar,Magnification,Gestures');
        const workspaceIcon = pages.get_item(0).get_child().get_icon_name();
        check('Workspace Bar has an available symbolic icon', workspaceIcon?.endsWith('-symbolic')
            && Gtk.IconTheme.get_for_display(window.get_display()).has_icon(workspaceIcon));
        const headerSwitcher = widgets.find(w => w instanceof Adw.ViewSwitcher && w.get_policy() === Adw.ViewSwitcherPolicy.WIDE);
        const tabPadding = walk(headerSwitcher).filter(w => w instanceof Gtk.ToggleButton).map(button => {
            const [, outer] = button.compute_bounds(window), [, inner] = button.get_child().get_visible_child().compute_bounds(window);
            return [inner.get_x() - outer.get_x(), outer.get_x() + outer.get_width() - inner.get_x() - inner.get_width()];
        }).flat();
        check('header tabs have equal padding around their icon and label', Math.max(...tabPadding) - Math.min(...tabPadding) <= 1);
        check('the old middle-click switch has moved out of Behaviour', !row('Middle-Click Closes Window'));
        const gestureRow = key => widgets.find(w => w.get_name() === key);
        const gestureChoice = key => walk(gestureRow(key)).find(w => w instanceof Gtk.DropDown);
        check('both gesture targets expose every input', ['app', 'workspace'].every(kind =>
            ['left-click', 'middle-click', 'right-click', 'scroll-up', 'scroll-down', 'horizontal-scroll'].every(input => !!gestureChoice(`gesture-${kind}-${input}`))));
        const horizontalSwitch = gestureRow('gesture-horizontal-switch-workspaces');
        const natural = gestureRow('gesture-horizontal-natural-scroll');
        const naturalRows = ['switching', 'movement'].map(kind => gestureRow(`gesture-horizontal-natural-${kind}`));
        check('natural swiping has two independently selectable checkbox rows', natural instanceof Adw.SwitchRow
            && naturalRows.every(target => walk(target).some(widget => widget instanceof Gtk.CheckButton)));
        check('natural swipe action groups are unavailable until natural swiping is enabled', naturalRows.every(target => !target.get_sensitive()));
        natural.set_active(true);
        check('enabling natural swiping makes both action groups available', settings.get_boolean('gesture-horizontal-natural-scroll') && naturalRows.every(target => target.get_sensitive()));
        naturalRows[0].activate();
        check('the workspace-switching checkbox persists independently', !settings.get_boolean('gesture-horizontal-natural-switching') && settings.get_boolean('gesture-horizontal-natural-movement'));
        natural.set_active(false); natural.set_active(true);
        check('turning natural swiping off and on preserves its action selection', !walk(naturalRows[0]).find(widget => widget instanceof Gtk.CheckButton).get_active());
        for (const key of ['gesture-horizontal-natural-scroll', 'gesture-horizontal-natural-switching', 'gesture-horizontal-natural-movement']) settings.reset(key);
        check('Workspace Bar has a smooth highlight option under Animation', row('Smooth Workspace Highlight') instanceof Adw.SwitchRow);
        const horizontalRows = ['app','workspace'].map(kind => gestureRow(`gesture-${kind}-horizontal-scroll`));
        check('shared horizontal switching follows the fixture', horizontalSwitch instanceof Adw.SwitchRow && horizontalSwitch.get_active());
        check('shared switching fades both per-target horizontal rows', horizontalRows.every(row => !row.get_sensitive()));
        horizontalSwitch.set_active(false);
        check('disabling shared switching enables both horizontal rows', !settings.get_boolean('gesture-horizontal-switch-workspaces')
            && horizontalRows.every(row => row.get_sensitive()));
        gestureChoice('gesture-app-horizontal-scroll').set_selected(1);
        horizontalSwitch.set_active(true); horizontalSwitch.set_active(false);
        check('shared switch preserves the per-target horizontal choices', settings.get_string('gesture-app-horizontal-scroll') === 'none');
        settings.reset('gesture-app-horizontal-scroll'); horizontalSwitch.set_active(true);
        const labels = dropdown => {const model=dropdown.get_model();return Array.from({length:model.get_n_items()},(_,i)=>model.get_string(i));};
        check('horizontal target menus omit switching and bar scrolling', ['app','workspace'].every(kind =>
            labels(gestureChoice(`gesture-${kind}-horizontal-scroll`)).every(label => !['Switch Workspaces','Scroll the Workspace Bar'].includes(label))));
        check('click menus omit directional actions', ['app','workspace'].every(kind => ['left-click','middle-click','right-click'].every(input =>
            labels(gestureChoice(`gesture-${kind}-${input}`)).every(label => !/Previous|Next|Earlier|Later/.test(label)))));
        check('Overview is available only in workspace gesture menus', ['left-click','middle-click','right-click','scroll-up','scroll-down'].every(input =>
            !labels(gestureChoice(`gesture-app-${input}`)).includes('Toggle Overview')
            && labels(gestureChoice(`gesture-workspace-${input}`)).includes('Toggle Overview')));
        check('Open New Instance is available only for app gestures', ['left-click','middle-click','right-click','scroll-up','scroll-down'].every(input =>
            labels(gestureChoice(`gesture-app-${input}`)).includes('Open New Instance')
            && !labels(gestureChoice(`gesture-workspace-${input}`)).includes('Open New Instance')));
        check('app middle click defaults to opening a new instance', settings.get_string('gesture-app-middle-click') === 'new-instance');
        const middleChoice = gestureChoice('gesture-app-middle-click');
        middleChoice.set_selected(labels(middleChoice).indexOf('Close Windows'));
        check('gesture dropdown changes persist immediately', settings.get_string('gesture-app-middle-click') === 'close');
        settings.set_string('gesture-app-middle-click', 'none');
        check('gesture dropdown follows changes elsewhere', middleChoice.get_selected_item().get_string() === 'Do Nothing');
        settings.reset('gesture-app-middle-click');
        check('vertical gesture defaults match move and close actions', ['app', 'workspace'].every(kind =>
            settings.get_string(`gesture-${kind}-scroll-up`) === 'move-active' && settings.get_string(`gesture-${kind}-scroll-down`) === 'close'));
        const choice = title => title === 'Vertical Alignment' ? widgets.find(w => w.get_name() === 'magnification-vertical-alignment') : walk(row(title)).find(w => w instanceof Gtk.DropDown);
        const groups = widgets.filter(w => w instanceof Adw.PreferencesGroup);
        const advanced = widgets.find(w => w.get_name() === 'advanced-magnification-settings');
        const advancedSwitch = walk(advanced).find(w => w instanceof Gtk.Switch);
        const curve = widgets.find(w => w.get_name() === 'curve-settings');
        const hoverSwitch = walk(row('Hover Magnification')).find(w => w instanceof Gtk.Switch);
        const menus = ['size', 'spacing', 'circle', 'highlight', 'style'].map(name => widgets.find(w => w.get_name() === `advanced-${name}`));
        const trash = widgets.find(w => w.get_name() === 'delete-magnification-preset');
        const example = widgets.find(w => w.get_name() === 'magnification-example-count');
        const lift = widgets.find(w => w.get_name() === 'magnification-lift-slider');
        const presetDropdown = widgets.find(w => w.get_name() === 'magnification-preset');
        const presetLabel = () => presetDropdown.get_selected_item().get_string();
        const controls = widgets.find(w => w.get_name() === 'magnification-controls');
        const section = title => groups.find(g => g.get_title() === title);
        const toolButton = label => widgets.find(w => w instanceof Gtk.ToggleButton && w.get_label() === label);
        const graph = widgets.filter(w => w instanceof Gtk.DrawingArea)[0];
        const select = async label => {for (const name of ['Size', 'Width', 'Shape', 'Spacing', 'Cutoff']) toolButton(name).set_active(name === label); await delay(90);};
        const toggle = async (label, active) => {toolButton(label).set_active(active); await delay(90);};
        const resize = async width => {
            window.set_default_size(width, 860);
            for (let i = 0; i < 40; i++) {
                await delay(50);
                if (window.get_width() === width) {await delay(90); return;}
            }
        };
        const show = async widget => {
            // Scroll the preferences page, including when the graph has its own scroller.
            let scroller;
            for (let parent = widget.get_parent(); parent; parent = parent.get_parent())
                if (parent instanceof Gtk.ScrolledWindow) scroller = parent;
            const [ok, bounds] = widget.compute_bounds(scroller.get_child());
            if (ok) scroller.get_vadjustment().set_value(Math.max(0, bounds.get_y() - 24));
            await delay(120);
        };
        const current = () => {
            const preset = sizePreset(settings.get_string('size-mode')), options = readMagnificationOptions(settings, preset);
            const model = magnificationGraphModel({...options, maxSize: peakIconSize(options, preset.iconSize)}, preset.iconSize, preset.iconSpacing, settings.get_int('magnification-example-count'));
            return {model, view: magnificationGraphViewport(model, graph.get_width(), graph.get_height(), settings.get_int('magnification-graph-zoom') / 100)};
        };
        const controllers = graph.observe_controllers(); let gesture;
        for (let i = 0; i < controllers.get_n_items(); i++) if (controllers.get_item(i) instanceof Gtk.GestureDrag) gesture = controllers.get_item(i);
        const drag = (x, y, dx, dy) => {gesture.emit('drag-begin', x, y); gesture.emit('drag-update', dx, dy); gesture.emit('drag-end', dx, dy);};
        row('Empty Workspace Cooldown').set_value(45);
        check('empty workspace cooldown persists independently', settings.get_int('empty-workspace-cooldown') === 45);
        check('zero cooldown can restore GNOME defaults', (row('Empty Workspace Cooldown').set_value(0), settings.get_int('empty-workspace-cooldown') === 0));
        settings.reset('empty-workspace-cooldown');
        check('advanced controls start hidden', !advanced.get_expanded());
        check('advanced settings retain their native expander and enable switch', advanced instanceof Adw.ExpanderRow && advanced.get_show_enable_switch());
        check('choice settings use native dropdown buttons', !widgets.some(w => w instanceof Adw.ComboRow)
            && ['Vertical Alignment', 'Compression Mode', 'Empty Workspace Numbers', 'When Numbers Grow', 'Marker Spacing'].every(title => !!choice(title)));
        const editor = widgets.find(w => w.get_name() === 'magnification-editor-list');
        check('editor rows use one native preferences group', editor instanceof Adw.PreferencesGroup && row('Hover Magnification').get_parent() instanceof Gtk.ListBox
            && row('Hover Magnification').get_parent() === advanced.get_parent());
        const reset = widgets.find(w => w.get_name() === 'reset-magnification');
        const resetCurve = widgets.find(w => w.get_name() === 'reset-curve');
        check('the main reset starts with curve-only scope', reset.get_label() === 'Reset Curve');
        check('unchanged curve reset actions are unavailable', !reset.get_sensitive() && !resetCurve.get_sensitive());
        check('unchanged section resets are unavailable', ['size', 'spacing', 'circle', 'highlight', 'style']
            .every(name => !widgets.find(w => w.get_name() === `reset-${name}`).get_sensitive()));
        const [, advancedBounds] = advancedSwitch.compute_bounds(window), [, graphBounds] = graph.compute_bounds(window);
        check('advanced settings stay below the graph', advancedBounds.get_y() >= graphBounds.get_y() + graphBounds.get_height());
        const [, toolsBounds] = toolButton('Size').compute_bounds(window);
        check('tool buttons sit below the graph', toolsBounds.get_y() >= graphBounds.get_y() + graphBounds.get_height());
        check('example count and alignment are outside advanced settings', example.get_mapped() && choice('Vertical Alignment').get_mapped());
        const matchingToolHeights = () => ['Size', 'Width', 'Shape', 'Spacing', 'Cutoff']
            .every(name => toolButton(name).compute_bounds(window)[1].get_height()
                === choice('Vertical Alignment').compute_bounds(window)[1].get_height());
        check('graph tool buttons match the alignment dropdown height', matchingToolHeights());
        check('Icons uses the native spin row style', example instanceof Adw.SpinRow && example.get_title() === 'Icons:');
        const [, alignmentBounds] = choice('Vertical Alignment').compute_bounds(window);
        check('alignment and Lift sit at the right end below the graph', alignmentBounds.get_y() >= graphBounds.get_y() + graphBounds.get_height()
            && alignmentBounds.get_x() > window.get_width() * 2 / 3 && lift.get_mapped());
        check('graph explanatory status paragraphs are removed', !widgets.some(w => w instanceof Gtk.Label && /^(Visible:|\d+ px normal|Drag the peak up or down)/.test(w.get_label())));
        check('built-in presets have no trash button', !trash.get_visible());
        const presetIndex = label => Array.from({length: presetDropdown.get_model().get_n_items()}, (_, i) => i).find(i => presetDropdown.get_model().get_string(i) === label);
        presetDropdown.set_selected(presetIndex('Dock')); await delay(90);
        check('preset dropdown applies its curve and spacing', presetLabel() === 'Dock' && settings.get_int('magnification-scale') === 325 && settings.get_int('magnification-app-gap') === 10);
        const hiddenGraph = current(); drag(hiddenGraph.view.centre, hiddenGraph.view.py(hiddenGraph.model.peak), 0, -8); await delay(90);
        check('graph edits work with advanced settings closed and create Custom 1', !advanced.get_expanded() && presetLabel() === 'Custom 1');
        const firstCustom = settings.get_int('magnification-scale');
        const continued = current(); drag(continued.view.centre, continued.view.py(continued.model.peak), 0, -4); await delay(90);
        check('continued graph edits update the same custom entry', presetLabel() === 'Custom 1' && JSON.parse(settings.get_string('magnification-custom-presets')).length === 1 && settings.get_int('magnification-scale') > firstCustom);
        const savedScale = settings.get_int('magnification-scale');
        presetDropdown.set_selected(presetIndex('Subtle')); await delay(90);
        settings.set_int('magnification-sharpness', 105); await delay(90);
        check('editing another preset creates a separately numbered custom entry', presetLabel() === 'Custom 2');
        presetDropdown.set_selected(presetIndex('Custom 1')); await delay(90);
        check('saved custom presets restore their edited curve', settings.get_int('magnification-scale') === savedScale && presetLabel() === 'Custom 1');
        check('custom presets expose the trash button', trash.get_visible());
        check('edited curves enable both curve reset actions', reset.get_sensitive() && resetCurve.get_sensitive());
        presetDropdown.set_selected(presetIndex('Custom 2')); await delay(90); trash.emit('clicked'); await delay(90);
        check('trash advances to the next custom for repeated deletion', presetLabel() === 'Custom 1' && presetIndex('Custom 2') === undefined && trash.get_visible());
        reset.emit('clicked'); await delay(90);
        check('Reset Curve returns to the custom source preset', presetLabel() === 'Dock' && settings.get_int('magnification-scale') === 325);
        check('restoring the source disables curve reset even for a nondefault preset', !reset.get_sensitive() && !resetCurve.get_sensitive());
        presetDropdown.set_selected(presetIndex('Default')); await delay(90);
        settings.set_int('magnification-graph-zoom', 125); await delay(90);
        check('view changes do not replace the selected preset', presetLabel() === 'Default');
        settings.reset('magnification-graph-zoom');
        await show(advanced); advancedSwitch.set_active(true); await delay(240);
        check('advanced mode changes the main action to Reset All', reset.get_label() === 'Reset All');
        check('Curve has its own reset action', resetCurve.get_label() === 'Reset' && resetCurve.is_ancestor(curve));
        check('workspace numbers section is named for scaling', menus[0].get_title() === 'Workspace Numbers Scaling');
        check('advanced menus are individually collapsible and start closed', curve instanceof Adw.ExpanderRow && !curve.get_expanded() && menus.every(menu => menu instanceof Adw.ExpanderRow && !menu.get_expanded()));
        await show(curve); curve.set_expanded(true); await delay(240); await show(controls);
        check('Curve opens all five numeric panels together', ['Size', 'Width', 'Shape', 'Spacing', 'Cutoff'].every(name => section(name).get_visible()) && row('Peak Size').get_mapped());
        hoverSwitch.set_active(false); await delay(90);
        check('turning hover magnification off keeps configuration usable', ['Peak Size', 'Horizontal Compression c', 'Curve Shape', 'Enable Cutoff', 'When Numbers Grow', 'App Icon Opacity'].every(title => row(title).get_sensitive() && row(title).get_opacity() === 1) && graph.get_sensitive());
        hoverSwitch.set_active(true);
        curve.set_expanded(false); await toggle('Width', true);
        check('node toggles do not open or close Curve settings', !curve.get_expanded());
        await toggle('Width', false); curve.set_expanded(true); await delay(240); await show(controls);
        choice('Vertical Alignment').set_selected(1);
        check('dropdown buttons persist their selected setting', settings.get_string('magnification-vertical-alignment') === 'center-line');
        settings.set_string('magnification-vertical-alignment', 'panel-edge');
        check('dropdown buttons follow settings changed elsewhere', choice('Vertical Alignment').get_selected() === 0);
        const beforeLift = current(), beforeLiftHeight = graph.get_height();
        lift.set_value(1.26); await delay(90);
        const afterLift = current();
        check('Lift leaves the graph position and canvas height fixed', beforeLiftHeight === graph.get_height() && beforeLift.view.py(beforeLift.model.peak) === afterLift.view.py(afterLift.model.peak));
        check('Lift snaps to half icon heights', lift.get_value() === 1.5 && settings.get_int('magnification-lift') === 30);
        lift.set_value(99);
        check('Lift stops at plus two', lift.get_value() === 2 && settings.get_int('magnification-lift') === 40);
        const marks = walk(lift).filter(w => w instanceof Gtk.Label).map(w => w.get_text());
        check('Lift labels only whole steps', ['0', '+1×', '+2×'].every(label => marks.includes(label)) && !marks.some(label => label.includes('.5')));
        check('the duplicate advanced Lift control is removed', !row('Lift from Panel'));
        settings.set_int('magnification-lift', 10);
        check('Lift slider follows settings changed elsewhere', lift.get_value() === 0.5);
        settings.reset('magnification-lift');
        check('graph starts at actual size', settings.get_int('magnification-graph-zoom') === 100);
        check('all numeric panels stay in their two columns', section('Size').get_parent() !== section('Width').get_parent());
        check('workspace preview section is removed', !groups.some(g => g.get_title() === 'Workspace Preview') && widgets.filter(w => w instanceof Gtk.DrawingArea).length === 1);
        await toggle('Width', true);
        check('tool toggles retain other visible sections', toolButton('Size').get_active() && toolButton('Width').get_active());
        check('multiple sections use two columns', section('Size').get_parent() !== section('Width').get_parent());
        check('the two columns have equal width', Math.abs(section('Size').get_width() - section('Width').get_width()) <= 2);
        await toggle('Shape', true);
        check('a third section continues in the first column', section('Shape').get_parent() === section('Size').get_parent());
        const shapeTop = section('Shape').get_allocation().y;
        check('short sections stack without waiting for the taller column', shapeTop === section('Size').get_height() + 16 && shapeTop < section('Width').get_height());
        await show(graph); let simultaneous = current();
        drag(simultaneous.view.centre, simultaneous.view.py(simultaneous.model.peak), 0, -8);
        check('size node works while other nodes are visible', settings.get_int('magnification-scale') > 250);
        settings.reset('magnification-scale'); await delay(90); simultaneous = current();
        drag(simultaneous.view.px(simultaneous.model.shoulder.x), simultaneous.view.py(simultaneous.model.shoulder.y), 0, 8);
        check('shape node also works without hiding size or width', settings.get_int('magnification-sharpness') > 100 && toolButton('Size').get_active() && toolButton('Width').get_active());
        settings.reset('magnification-sharpness'); await toggle('Width', false);
        check('turning off a node leaves every numeric panel available', ['Size', 'Width', 'Shape', 'Spacing', 'Cutoff'].every(name => section(name).get_visible()) && curve.get_expanded());
        await toggle('Shape', false);
        check('selecting one node does not change settings columns', section('Size').get_parent() !== section('Width').get_parent());
        await toggle('Size', false);
        const beforeHiddenDrag = settings.get_int('magnification-scale'), hidden = current();
        drag(hidden.view.centre, hidden.view.py(hidden.model.peak), 0, -8);
        check('all nodes can be hidden without hiding numeric settings', controls.get_visible() && curve.get_expanded() && settings.get_int('magnification-scale') === beforeHiddenDrag);
        check('visibility choices persist independently of curve values', settings.get_strv('magnification-visible-tools').length === 0);
        await select('Size');
        let {model, view} = current();
        drag(view.centre, view.py(model.peak), 0, -12);
        check('size handle edits peak size', settings.get_int('magnification-scale') > 250);
        settings.reset('magnification-scale'); await select('Width');
        check('width tool shows its configuration', section('Width').get_visible());
        ({model, view} = current()); drag(view.px(model.reachX), view.floor + 9, 12, 0);
        check('width handle adjusts compression', settings.get_int('magnification-compression') < 100);
        settings.reset('magnification-compression'); await select('Shape');
        check('shape tool shows its configuration', section('Shape').get_visible());
        ({model, view} = current()); drag(view.px(model.shoulder.x), view.py(model.shoulder.y), 0, 12);
        check('shoulder handle edits shape', settings.get_int('magnification-sharpness') > 100);
        settings.reset('magnification-sharpness'); await select('Spacing');
        check('spacing tool shows its configuration', section('Spacing').get_visible());
        ({model, view} = current()); const marker = model.markers.find(point => point.source > 0);
        drag(view.px(marker.x), view.physicalY(marker.top), 12, 0);
        check('dragging an app edits custom spacing', !settings.get_boolean('magnification-preset-app-gap') && settings.get_int('magnification-app-gap') > 5);
        settings.reset('magnification-preset-app-gap'); settings.reset('magnification-app-gap'); await select('Cutoff');
        check('cutoff tool shows its configuration', section('Cutoff').get_visible());
        ({model, view} = current()); drag(view.px(model.cutoffX), view.floor + 9, -20, 0);
        check('cutoff handle edits the symmetric boundary', settings.get_int('magnification-cutoff-distance') < 96);
        settings.reset('magnification-cutoff-distance');
        const savedCutoff = settings.get_int('magnification-cutoff-distance');
        const cutoff = row('Enable Cutoff');
        check('cutoff is a regular settings group with always-visible distance controls', cutoff instanceof Adw.SwitchRow && row('Cutoff Distance').get_mapped() && row('Cutoff Transition').get_mapped());
        cutoff.set_active(false); await delay(90);
        check('cutoff can be disabled independently of its visibility', !settings.get_boolean('magnification-cutoff-enabled') && toolButton('Cutoff').get_active());
        check('disabled cutoff greys its distance and transition controls', !row('Cutoff Distance').get_sensitive() && !row('Cutoff Transition').get_sensitive());
        check('disabled cutoff uses the full curve beyond the old boundary', current().model.kernelScaleAt(savedCutoff + 1) > 1);
        cutoff.set_active(true); await delay(90);
        check('enabling cutoff restores its saved distance', settings.get_int('magnification-cutoff-distance') === savedCutoff && row('Cutoff Distance').get_sensitive());
        await toggle('Cutoff', false);
        check('hiding cutoff settings does not disable the actual cutoff', settings.get_boolean('magnification-cutoff-enabled'));
        await select('Cutoff');
        const button = label => label === 'Reset Curve' ? resetCurve : widgets.find(w => w instanceof Gtk.Button && w.get_label() === label);
        widgets.find(w => w instanceof Gtk.Button && w.get_icon_name() === 'zoom-in-symbolic').emit('clicked');
        check('zoom in scales both axes together', settings.get_int('magnification-graph-zoom') === 125);
        button('1:1').emit('clicked');
        check('actual size restores precisely 100 percent', settings.get_int('magnification-graph-zoom') === 100);
        check('Fit is removed from graph controls', !widgets.some(w => w instanceof Gtk.Button && w.get_label() === 'Fit'));
        button('1:1').emit('clicked');
        await select('Width'); settings.set_int('magnification-compression', 5); settings.set_int('magnification-example-count', 1); await delay(100);
        ({model, view} = current());
        check('wide curve handles remain in the scrollable canvas', graph.get_width() >= model.reachX * 2 * view.zoom + 72);

        settings.reset('magnification-compression'); settings.reset('magnification-example-count'); button('1:1').emit('clicked'); await select('Cutoff');
        row('Cutoff Distance').set_value(55);
        check('numeric cutoff still persists', settings.get_int('magnification-cutoff-distance') === 55);
        await select('Width'); choice('Compression Mode').set_selected(1);
        check('dynamic mode enables its reference count', row('Reference Icon Count').get_sensitive());
        choice('Compression Mode').set_selected(2);
        check('crowded bars can narrow the curve', settings.get_string('magnification-reach-response') === 'more');
        example.set_value(5); check('preview app count is available beside the graph', settings.get_int('magnification-example-count') === 5);
        settings.set_boolean('show-active-workspace-ring', false); button('Reset Curve').emit('clicked');
        check('curve reset preserves workspace appearance', !settings.get_boolean('show-active-workspace-ring') && settings.get_int('magnification-compression') === 100);
        settings.reset('show-active-workspace-ring');
        advancedSwitch.set_active(true);
        check('advanced toggle reveals workspace options', advanced.get_expanded());
        check('every setting explains its effect', rows.filter(w => w.get_title()).every(w => !!w.get_subtitle() || !!w.get_tooltip_text()));
        await select('Size'); const peakWidgets = walk(row('Peak Size'));
        const peakValue = peakWidgets.find(w => w instanceof Gtk.SpinButton), units = peakWidgets.find(w => w instanceof Gtk.DropDown);
        const activateDropdownRow = async (title, dropdown) => {
            const target = row(title);
            for (let parent = target.get_parent(); parent; parent = parent.get_parent())
                if (parent instanceof Adw.ExpanderRow) parent.set_expanded(true);
            await delay(70);
            await show(target);
            check(`${title} has native actionable-row hover styling`, target.get_activatable() && target.get_activatable_widget() === dropdown);
            target.activate(); await delay(350);
            const popup = walk(dropdown).find(widget => widget instanceof Gtk.Popover);
            check(`${title} row activation opens its dropdown`, popup?.get_mapped());
            popup.popdown(); await delay(70);
        };
        await activateDropdownRow('Peak Size', units);
        const compressionRow = row('Horizontal Compression c');
        const compressionSpin = walk(compressionRow).find(widget => widget instanceof Gtk.SpinButton);
        await show(compressionRow); compressionRow.activate(); await delay(70);
        check('Compression row activation focuses its numeric control', compressionRow.get_activatable()
            && compressionRow.get_activatable_widget() === compressionSpin && walk(compressionSpin).includes(window.get_focus()));
        peakValue.set_value(100); units.set_selected(1);
        check('switching to pixels preserves peak size', settings.get_string('magnification-peak-mode') === 'pixels' && peakValue.get_value_as_int() === 20);
        peakValue.set_value(64); units.set_selected(0);
        check('switching to percent preserves peak size', settings.get_int('magnification-scale') === 320);
        await select('Spacing'); const gapWidgets = walk(row('App Icon Gap'));
        const gapMode = gapWidgets.find(w => w instanceof Gtk.DropDown), gap = gapWidgets.find(w => w instanceof Gtk.SpinButton);
        for (const title of ['App Icon Gap', 'Number-to-Icon Gap', 'Minimum Workspace Gap'])
            await activateDropdownRow(title, walk(row(title)).find(widget => widget instanceof Gtk.DropDown));
        check('automatic spacing hides the custom gap', !gap.get_visible());
        gapMode.set_selected(1); gap.set_value(14); choice('Marker Spacing').set_selected(2);
        check('diminishing mode reveals its relevant control', row('Spacing Falloff').get_visible() && row('Spacing Falloff').get_sensitive());
        choice('Marker Spacing').set_selected(0);
        check('other modes hide irrelevant falloff', !row('Spacing Falloff').get_visible());
        choice('Empty Workspace Numbers').set_selected(2);
        check('empty-workspace choice updates both values', settings.get_boolean('magnification-empty-numbers') && !settings.get_boolean('magnification-empty-hover-only'));
        choice('When Numbers Grow').set_selected(2);
        check('normal-size numbers disable growth controls', !row('Number Growth').get_sensitive() && !row('Empty Workspace Numbers').get_sensitive());
        const optical = row('Optical Centring');
        check('circle corrections are replaced by one optical centring switch', optical instanceof Adw.SwitchRow
            && !row('Circle Centring Corrections') && !row('Optical Centring Strength')
            && !row('Circle Horizontal Offset') && !row('Circle Vertical Offset'));
        optical.set_active(false);
        check('optical centring can be disabled', readMagnificationOptions(settings, sizePreset('medium')).opticalStrength === 0);
        optical.set_active(true);
        check('optical centring enables the standard correction', readMagnificationOptions(settings, sizePreset('medium')).opticalStrength === 1);
        settings.set_int('magnification-optical-strength', 0);
        check('optical centring switch follows changes elsewhere', !optical.get_active());
        check('changed circle settings enable their reset', widgets.find(w => w.get_name() === 'reset-circle').get_sensitive());
        widgets.find(w => w.get_name() === 'reset-circle').emit('clicked');
        check('circle reset restores optical centring and becomes unavailable', optical.get_active() && settings.get_int('magnification-optical-strength') === 100
            && !widgets.find(w => w.get_name() === 'reset-circle').get_sensitive());
        row('Active Workspace Circle').set_active(false);
        check('disabled circle disables its controls', !row('Circle Inset').get_sensitive() && !optical.get_sensitive());
        const highlight = widgets.find(w => w.get_name() === 'advanced-highlight');
        check('focused highlight has its own collapsed section', highlight instanceof Adw.ExpanderRow && !highlight.get_expanded());
        check('custom highlight colour is hidden until selected', !row('Custom Highlight Colour').get_visible());
        const darkOpacity = settings.get_int('magnification-icon-shadow-opacity');
        row('Highlight Opacity').set_value(0);
        check('zero highlight opacity disables its shape controls without changing dark shadows', !row('Highlight Width').get_sensitive()
            && row('Icon Shadow Blur').get_sensitive() && settings.get_int('magnification-icon-shadow-opacity') === darkOpacity);
        row('Highlight Opacity').set_value(65); row('Highlight Softness').set_value(40);
        row('Highlight Width').set_value(170); row('Highlight Height').set_value(55); row('Highlight Vertical Offset').set_value(7);
        let highlightOptions = readMagnificationOptions(settings, sizePreset('medium'));
        check('highlight controls persist independent rendering options', highlightOptions.focusHighlightOpacity === 0.65
            && highlightOptions.focusHighlightSoftness === 0.4 && highlightOptions.focusHighlightWidth === 1.7
            && highlightOptions.focusHighlightHeight === 0.55 && highlightOptions.focusHighlightOffset === 7);
        choice('Highlight Colour').set_selected(2);
        const colourButton = widgets.find(w => w.get_name() === 'magnification-focus-highlight-color');
        const colour = new Gdk.RGBA(); colour.parse('#fd4f18'); colourButton.set_rgba(colour);
        check('custom highlight colour uses the native picker and persists', colourButton instanceof Gtk.ColorDialogButton
            && row('Custom Highlight Colour').get_visible() && settings.get_string('magnification-focus-highlight-color') === '#fd4f18');
        row('Enable Highlight').set_active(false);
        check('highlight can be disabled independently', !readMagnificationOptions(settings, sizePreset('medium')).focusHighlightEnabled
            && !row('Highlight Opacity').get_sensitive() && settings.get_int('magnification-icon-shadow-opacity') === darkOpacity);
        widgets.find(w => w.get_name() === 'reset-highlight').emit('clicked');
        highlightOptions = readMagnificationOptions(settings, sizePreset('medium'));
        check('highlight reset restores its original appearance and leaves dark shadows intact', highlightOptions.focusHighlightEnabled
            && highlightOptions.focusHighlightOpacity === 0.8 && highlightOptions.focusHighlightSoftness === 1
            && highlightOptions.focusHighlightWidth === 1 && highlightOptions.focusHighlightHeight === 1 && highlightOptions.focusHighlightOffset === 0
            && highlightOptions.focusHighlightColorMode === 'icon' && settings.get_int('magnification-icon-shadow-opacity') === darkOpacity);
        row('Icon Shadow Opacity').set_value(0);
        check('disabled shadows disable their shape controls', !row('Icon Shadow Blur').get_sensitive());
        row('Transition Duration').set_value(0);
        check('instant transitions disable easing', !row('Transition Easing').get_sensitive());
        check('shadow details start collapsed', !row('App Icon Shadows').get_expanded());
        settings.set_int('magnification-spacing', 23);
        widgets.find(w => w.get_name() === 'reset-spacing').emit('clicked');
        check('workspace spacing reset preserves the curve and other sections', settings.get_value('magnification-spacing').equal(settings.get_default_value('magnification-spacing')) && !settings.get_boolean('magnification-preset-app-gap') && settings.get_int('magnification-scale') === 320);
        advanced.set_expanded(false);
        check('collapsing advanced settings retains Reset All while the switch is on', reset.get_label() === 'Reset All');
        advancedSwitch.set_active(false);
        check('hiding advanced controls restores Reset Curve and preserves choices', !advanced.get_expanded() && reset.get_label() === 'Reset Curve' && settings.get_int('magnification-scale') === 320);
        advancedSwitch.set_active(true);
        check('changed magnification settings enable Reset All', reset.get_label() === 'Reset All' && reset.get_sensitive());
        const savedCustoms = JSON.parse(settings.get_string('magnification-custom-presets')).map(entry => entry.number);
        reset.emit('clicked');
        check('global reset restores all magnification settings', MAGNIFICATION_KEYS.every(key => settings.get_value(key).equal(settings.get_default_value(key))));
        check('Reset All becomes unavailable and keeps saved custom presets', !reset.get_sensitive()
            && JSON.stringify(savedCustoms) === JSON.stringify(JSON.parse(settings.get_string('magnification-custom-presets')).map(entry => entry.number)));
        hoverSwitch.set_active(false);
        check('disabling Hover Magnification does not enable Reset All', !reset.get_sensitive());
        row('Highlight Opacity').set_value(65);
        check('configuration edits still enable Reset All while hover is disabled', reset.get_sensitive());
        row('Highlight Opacity').set_value(80);
        check('restoring configuration disables Reset All even while hover remains off', !reset.get_sensitive() && !hoverSwitch.get_active());
        hoverSwitch.set_active(true);
        check('enabling Hover Magnification alone keeps Reset All unavailable', !reset.get_sensitive());
        peakValue.set_value(280); const observer = new Gio.Settings({settings_schema: settings.settings_schema});
        check('edits after reset persist immediately', observer.get_int('magnification-scale') === 280);
        peakValue.set_value(250); await select('Size');
        const artifact = GLib.getenv('WSB_PREFERENCES_SCREENSHOT');
        const capture = widget => {if (widget !== window) capture(window); const paintable = new Gtk.WidgetPaintable({widget}), snapshot = new Gtk.Snapshot(); paintable.snapshot(snapshot, widget.get_width(), widget.get_height()); return window.get_renderer().render_texture(snapshot.to_node(), null);};
        if (artifact) {
            capture(window).save_to_png(artifact);
            advancedSwitch.set_active(true); await delay(240);
            for (const name of ['Width', 'Shape', 'Spacing', 'Cutoff']) await toggle(name, true);
            capture(window).save_to_png(artifact + '-multi.png'); capture(graph).save_to_png(artifact + '-graph.png');
        }
        await resize(660);
        check('the window can shrink and settings adapt to one column', window.get_width() <= 700 && controls.get_orientation() === Gtk.Orientation.VERTICAL);
        const sizeLabel = toolButton('Size').get_child();
        check('Size stays on one line in a narrow window', !sizeLabel.get_wrap() && toolButton('Size').get_width() >= sizeLabel.measure(Gtk.Orientation.HORIZONTAL, -1)[0]);
        await resize(480); await show(graph);
        check('compact settings retain the single column', controls.get_orientation() === Gtk.Orientation.VERTICAL);
        check('wrapped graph tools keep the alignment dropdown height', matchingToolHeights());
        check('narrow section resets keep their text labels', [resetCurve, ...['size', 'spacing', 'circle', 'style'].map(name => widgets.find(w => w.get_name() === `reset-${name}`))]
            .every(button => button.get_label() === 'Reset'));
        const [, placementBounds] = lift.get_parent().get_parent().compute_bounds(window);
        const [, nodeBounds] = widgets.find(w => w.get_name() === 'magnification-tools').compute_bounds(window);
        check('wrapped placement controls restart at the left', placementBounds.get_y() >= nodeBounds.get_y() + nodeBounds.get_height()
            && Math.abs(placementBounds.get_x() - nodeBounds.get_x()) <= 4);
        check('wrapped tool and placement rows have more vertical space', placementBounds.get_y() - nodeBounds.get_y() - nodeBounds.get_height() >= 18);
        const [, wrappedAlignment] = choice('Vertical Alignment').compute_bounds(window), [, wrappedLift] = lift.get_parent().compute_bounds(window);
        check('alignment moves before Lift with a wider gap when controls wrap', wrappedLift.get_x() - wrappedAlignment.get_x() - wrappedAlignment.get_width() >= 20);
        await resize(1040); await show(graph);
        check('wide section resets keep their text labels', [resetCurve, ...['size', 'spacing', 'circle', 'style'].map(name => widgets.find(w => w.get_name() === `reset-${name}`))]
            .every(button => button.get_child() instanceof Gtk.Label && button.get_child().get_label() === 'Reset'));
        const [, wideAlignment] = choice('Vertical Alignment').compute_bounds(window), [, wideLift] = lift.get_parent().compute_bounds(window);
        check('Lift returns before alignment when the controls fit', wideLift.get_x() < wideAlignment.get_x());
        print(`${count} preferences checks passed`);
    })().catch(error => {failure = error; printerr(error.stack);}).finally(() => {window.close(); app.quit();});
});
await app.runAsync([]);
if (failure) throw failure;
