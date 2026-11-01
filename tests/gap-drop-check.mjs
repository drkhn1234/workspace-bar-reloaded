// Native pointer regression: a magnified drag visits a gap, then an occupied cell.
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
const bounds = actor => {
    const [x, y] = actor.get_transformed_position(), [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
};

export async function checkGapToWorkspaceDrop(bar, window) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw new Error('Requires isolated memory settings');
    const results = [], extension = bar._ext, settings = extension.getSettings();
    const manager = global.workspace_manager, windows = global.get_window_actors().map(actor => actor.meta_window);
    const other = windows.find(candidate => candidate !== window);
    if (windows.length !== 2 || !other) throw new Error('Requires two fixture windows');
    const original = {options: extension.getMagnificationOptions, active: manager.get_active_workspace(),
        workspaces: windows.map(window => window.get_workspace()), panelY: Main.layoutManager.panelBox.y,
        combine: settings.get_value('combine-icons')};
    const controls = [];
    const pointer = global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const move = async (x, y) => {
        pointer.notify_relative_motion(GLib.get_monotonic_time(), x - global.get_pointer()[0], 0); await delay(35);
        pointer.notify_relative_motion(GLib.get_monotonic_time(), 0, y - global.get_pointer()[1]); await delay(60);
    };
    const check = (name, valid) => {if (!valid) throw new Error(name); results.push(name);};
    let held = false, enabled = true;
    try {
        extension.getMagnificationOptions = () => ({...original.options.call(extension), enabled, lift: 0, duration: 0, dragDelay: 100});
        settings.set_boolean('combine-icons', false);
        const sourceWorkspace = window.get_workspace();
        const destination = manager.get_workspace_by_index(sourceWorkspace.index() + 1);
        other.change_workspace(destination); await delay(350);
        for (const magnified of [true, false]) for (const bottom of [false, true]) {
            enabled = magnified; sourceWorkspace.activate(global.get_current_time());
            const monitor = Main.layoutManager.primaryMonitor, panel = Main.layoutManager.panelBox;
            panel.set_y(bottom ? monitor.y + monitor.height - panel.height : monitor.y); await delay(100);
            const magnifier = bar._magnifier;
            if (!controls.some(saved => saved.magnifier === magnifier))
                controls.push({magnifier, pointer: magnifier._checkPointer, menu: magnifier._hasOpenMenu});
            magnifier._checkPointer = () => {}; magnifier._hasOpenMenu = () => true;
            magnifier._setActive(false, true); magnifier._clearEntries();
            const sourceButton = bar._container.get_children().find(button => button.wsIndex === sourceWorkspace.index());
            const source = sourceButton._wsbIconsWrapper.get_children().find(icon => icon.windowObj === window);
            let sourceBounds = bounds(source);
            if (magnified) {
                magnifier._lastPointerX = sourceBounds.x + sourceBounds.width / 2;
                magnifier._setActive(true, true); magnifier._draw(); await delay(80);
                sourceBounds = bounds(magnifier._entries.get(source).proxy);
            }
            const startY = magnified ? (bottom ? monitor.y + monitor.height - 1 : monitor.y) : bounds(source).y + bounds(source).height / 2;
            await move(sourceBounds.x + sourceBounds.width / 2, startY);
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED); held = true;
            await delay(magnified ? 140 : 440);
            await move(sourceBounds.x + sourceBounds.width / 2, startY + (bottom ? -18 : 18));
            check(`${magnified ? 'magnified' : 'normal'} ${bottom ? 'bottom' : 'top'} drag begins`, magnifier._dragging);
            const target = bar._container.get_children().find(button => button.wsIndex === destination.index());
            const previous = bar._container.get_children().find(button => button.wsIndex === destination.index() - 1);
            const before = bounds(previous), after = bounds(target), container = bounds(bar._container);
            await move((before.x + before.width + after.x) / 2, container.y + container.height / 2);
            check('visiting a gap offers new-workspace insertion', !!bar._insertionIndicator);
            const targetIcon = target._wsbIconsWrapper.get_children().find(icon => icon.windowObj === other);
            const targetBounds = bounds(targetIcon);
            await move(targetBounds.x + targetBounds.width / 2, targetBounds.y + targetBounds.height / 2);
            check('leaving the gap removes its insertion target', !bar._insertionIndicator);
            check('the occupied workspace offers a move over its app icon after leaving the gap', target.has_style_class_name('wsb-ws-btn-drag-hover'));
            const picked = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, ...global.get_pointer().slice(0, 2));
            check('the normal workspace is the native drop target', target === picked || target.contains(picked));
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED); held = false;
            await delay(300);
            check('the native drop moves the dragged window into the existing workspace', window.get_workspace() === destination);
            check('the existing target window stays on its workspace', other.get_workspace() === destination);
            window.change_workspace(sourceWorkspace); sourceWorkspace.activate(global.get_current_time()); await delay(250);
        }
        return results;
    } finally {
        if (held) {
            await move(800, Main.layoutManager.primaryMonitor.height / 2);
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await delay(300);
        }
        for (const saved of controls) {saved.magnifier._checkPointer = saved.pointer; saved.magnifier._hasOpenMenu = saved.menu;}
        windows.forEach((window, i) => window.change_workspace(original.workspaces[i]));
        original.active.activate(global.get_current_time());
        Main.layoutManager.panelBox.set_y(original.panelY);
        settings.set_value('combine-icons', original.combine);
        extension.getMagnificationOptions = original.options;
        bar._magnifier.suspend(); bar._magnifier.settingsChanged(true); await delay(250);
    }
}
