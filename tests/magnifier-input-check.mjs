// Import from an isolated GNOME Shell QA extension with fixture windows.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));

export async function checkMagnifiedInput(bar, icon) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw new Error('Requires isolated memory settings');
    const results = [], actions = [], magnifier = bar._magnifier, extension = bar._ext;
    const original = {options: extension.getMagnificationOptions, pointer: magnifier._checkPointer,
        menu: magnifier._hasOpenMenu, execute: bar._executeGestureAction, settings: bar._gestureSettings,
        click: bar._lastHandledIconTime, panelY: Main.layoutManager.panelBox.y};
    const check = (name, condition) => {if (!condition) throw new Error(name); results.push(name);};
    const pointer = global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const move = async (x, y) => {
        pointer.notify_relative_motion(GLib.get_monotonic_time(), x - global.get_pointer()[0], 0); await delay(60);
        pointer.notify_relative_motion(GLib.get_monotonic_time(), 0, y - global.get_pointer()[1]); await delay(80);
    };
    const click = async () => {
        bar._lastHandledIconTime = 0;
        const before = actions.length;
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED); await delay(40);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED); await delay(100);
        check('one native click executes one action', actions.length === before + 1);
        return actions.at(-1);
    };
    let enabled = true;
    try {
        extension.getMagnificationOptions = () => ({...original.options.call(extension), enabled, lift: 48, duration: 0});
        magnifier._checkPointer = () => {};
        magnifier._hasOpenMenu = () => false;
        bar._executeGestureAction = (target, action) => actions.push({target, action});
        bar._gestureSettings = {get_boolean: () => false, get_string: key => key.endsWith('left-click') ? (key.includes('-app-') ? 'activate' : 'overview')
            : key.endsWith('horizontal-scroll') ? 'move-windows' : key.endsWith('scroll-up') ? 'move-active' : 'close'};
        for (const bottom of [false, true]) {
            const monitor = Main.layoutManager.primaryMonitor, panel = Main.layoutManager.panelBox;
            panel.set_y(bottom ? monitor.y + monitor.height - panel.height : monitor.y); await delay(120);
            enabled = true; magnifier._setActive(true, true); magnifier._draw(); await delay(80);
            const entry = magnifier._entries.get(icon), [px] = entry.proxy.get_transformed_position(), [width] = entry.proxy.get_transformed_size();
            const x = px + width / 2, y = bottom ? monitor.y + monitor.height - 1 : monitor.y;
            const [vx] = bar._viewport.get_transformed_position(), [vw] = bar._viewport.get_transformed_size();
            check('projected app lies within the original panel region', x >= vx && x < vx + vw);
            await move(x, y); magnifier._draw();
            const action = await click();
            check(`${bottom ? 'bottom' : 'top'} screen-edge click targets the magnified app`, action.target.actor === icon && action.action === 'activate');
            check('projected clicks hold magnification through activation', !!magnifier._clickHold);
            enabled = false; magnifier._setActive(false, true); await delay(80);
            const normal = await click();
            check(`${bottom ? 'bottom' : 'top'} normal bar retains workspace clicks at the edge`, normal.target.kind === 'workspace' && normal.action === 'overview');
        }
        enabled = true; magnifier._setActive(true, true); magnifier._draw(); await delay(80);
        const entry = magnifier._entries.get(icon), [x,y] = entry.proxy.get_transformed_position(), [width,height] = entry.proxy.get_transformed_size();
        const event = (dx, dy, inverted, legacy = false, wheel = false) => ({
            get_source: () => entry.proxy, get_coords: () => [x + width / 2, y + height / 2],
            get_scroll_direction: () => wheel ? Clutter.ScrollDirection.UP : Clutter.ScrollDirection.SMOOTH,
            get_scroll_delta: () => [dx,dy], get_scroll_source: () => wheel ? Clutter.ScrollSource.WHEEL : Clutter.ScrollSource.FINGER,
            ...(legacy ? {} : {get_scroll_flags: () => inverted ? Clutter.ScrollFlags.INVERTED : 0}),
        });
        for (const inverted of [false,true]) for (const [dx,dy,expected] of [[0,-2,'move-active'],[0,2,'close'],[-2,0,'move-previous'],[2,0,'move-next']]) {
            bar._endScrollCapture(); const before = actions.length, sign = inverted ? -1 : 1;
            bar._onScrollEvent(event(dx * sign, dy * sign, inverted));
            check(`physical ${expected} follows native inversion flag ${inverted}`, actions.length === before + 1 && actions.at(-1).action === expected);
        }
        const touchpad = new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.touchpad'}), natural = touchpad.get_value('natural-scroll');
        try {
            for (const inverted of [false,true]) {
                touchpad.set_boolean('natural-scroll', inverted); bar._endScrollCapture();
                bar._onScrollEvent(event(0, inverted ? 2 : -2, inverted, true));
                check(`older shells recover physical up with natural scrolling ${inverted}`, actions.at(-1).action === 'move-active');
            }
        } finally {touchpad.set_value('natural-scroll', natural);}
        bar._endScrollCapture(); bar._scrollGesture.lastWheel = -Infinity;
        bar._onScrollEvent(event(0,-1,true,false,true));
        check('mouse-wheel direction is unaffected by touchpad correction', actions.at(-1).action === 'move-active');
        return results;
    } finally {
        Main.layoutManager.panelBox.set_y(original.panelY);
        bar._endScrollCapture(); bar._executeGestureAction = original.execute; bar._gestureSettings = original.settings;
        bar._lastHandledIconTime = original.click; magnifier._checkPointer = original.pointer;
        magnifier._hasOpenMenu = original.menu; extension.getMagnificationOptions = original.options;
        magnifier.suspend();
    }
}
