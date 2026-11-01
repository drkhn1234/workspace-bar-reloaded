// Import from a QA extension in an isolated GNOME Shell with fixture windows.
// This injects actual pointer events; it must never run in the user's session.
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));

export async function checkMagnifiedScroll(bar, icon) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw new Error('Requires isolated memory settings');
    const results = [], actions = [], magnifier = bar._magnifier, extension = bar._ext;
    const original = {options: extension.getMagnificationOptions, menu: magnifier._hasOpenMenu,
        execute: bar._executeGestureAction, settings: bar._gestureSettings};
    const check = (name, condition) => {if (!condition) throw new Error(name); results.push(name);};
    while (Main.layoutManager._startingUp) await delay(100);
    if (Main.overview.visible) {Main.overview.hide(); await delay(400);}
    const seat = global.stage.context.get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    try {
        extension.getMagnificationOptions = () => ({...original.options.call(extension), enabled: true, lift: 48, duration: 0});
        magnifier._hasOpenMenu = () => true;
        bar._executeGestureAction = (target, action) => actions.push({target, action});
        bar._gestureSettings = {get_boolean: () => false, get_string: key => key.endsWith('horizontal-scroll') ? 'move-windows'
            : key.endsWith('scroll-up') ? 'move-active' : 'close'};
        const [x] = icon.get_transformed_position(), [width] = icon.get_transformed_size();
        magnifier._lastPointerX = x + width / 2;
        magnifier._setActive(true, true); await delay(150); magnifier._draw(); await delay(50);
        const number = [...magnifier._entries.values()].find(entry => {
            const [px] = entry.proxy.get_transformed_position(), [w] = entry.proxy.get_transformed_size();
            return entry.workspaceButton && px > 0 && px + w < global.stage.width;
        })?.source;
        for (const [kind, source] of [['app', icon], ['workspace', number]]) {
            const entry = magnifier._entries.get(source);
            check(`${kind} has a magnified proxy`, !!entry);
            const [px, py] = entry.proxy.get_transformed_position(), [w, h] = entry.proxy.get_transformed_size();
            const cx = px + w / 2, cy = py + h / 2;
            const [, panelY] = Main.panel.get_transformed_position(), [, panelH] = Main.panel.get_transformed_size();
            check(`${kind} scroll target is outside the panel`, cy < panelY || cy > panelY + panelH);
            // Allow each axis to update before queuing the next virtual motion.
            pointer.notify_relative_motion(GLib.get_monotonic_time(), cx - global.get_pointer()[0], 0); await delay(60);
            pointer.notify_relative_motion(GLib.get_monotonic_time(), 0, cy - global.get_pointer()[1]); await delay(80);
            const [actualX, actualY] = global.get_pointer();
            check(`${kind} pointer reaches the lifted proxy`, Math.abs(actualX - cx) < 1 && Math.abs(actualY - cy) < 1);
            for (const [dx, dy, expected] of [[0, -20, 'move-active'], [0, 20, 'close'], [20, 0, 'move-next'], [-20, 0, 'move-previous']]) {
                bar._endScrollCapture(); const before = actions.length;
                pointer.notify_scroll_continuous(GLib.get_monotonic_time(), dx, dy, Clutter.ScrollSource.FINGER, 0);
                await delay(80);
                check(`${kind} ${expected} swipe fires once outside the panel`, actions.length === before + 1
                    && actions.at(-1).target.actor === (kind === 'workspace' ? source._wsbWorkspaceButton : source)
                    && actions.at(-1).action === expected);
                pointer.notify_scroll_continuous(GLib.get_monotonic_time(), 0, 0, Clutter.ScrollSource.FINGER,
                    Clutter.ScrollFinishFlags.HORIZONTAL | Clutter.ScrollFinishFlags.VERTICAL);
                await delay(50);
                check(`${kind} swipe end releases capture`, bar._scrollCaptureId === null);
            }
            const before = actions.length;
            pointer.notify_discrete_scroll(GLib.get_monotonic_time(), Clutter.ScrollDirection.UP, Clutter.ScrollSource.WHEEL);
            await delay(80);
            check(`${kind} wheel fires once outside the panel`, actions.length === before + 1
                && actions.at(-1).target.kind === kind && actions.at(-1).action === 'move-active');
        }
        return results;
    } finally {
        bar._endScrollCapture(); bar._executeGestureAction = original.execute; bar._gestureSettings = original.settings;
        magnifier._hasOpenMenu = original.menu; extension.getMagnificationOptions = original.options;
        magnifier.suspend();
    }
}
