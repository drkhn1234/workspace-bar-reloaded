// Real font metrics and workspace geometry in the isolated GNOME Shell.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Cairo from 'cairo';
import PangoCairo from 'gi://PangoCairo';

const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
export async function checkMagnifiedNumbers(bar) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw new Error('Requires isolated memory settings');
    const results = [], extension = bar._ext, manager = global.workspace_manager;
    const windows = global.get_window_actors().map(actor => actor.meta_window);
    if (windows.length !== 2) throw new Error('Requires two fixture windows');
    const original = {options: extension.getMagnificationOptions, active: manager.get_active_workspace(),
        workspaces: windows.map(window => window.get_workspace())};
    const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const animations = desktop.get_value('enable-animations');
    const controls = [];
    let duration = 0, easing = 'linear';
    const check = (name, valid) => {if (!valid) throw new Error(name); results.push(name);};
    try {
        desktop.set_boolean('enable-animations', true); await delay(30);
        extension.getMagnificationOptions = () => ({...original.options.call(extension), duration, easing});
        windows[0].change_workspace(manager.get_workspace_by_index(0));
        windows[1].change_workspace(manager.get_workspace_by_index(1));
        await delay(350);
        for (const index of [0, 1]) {
            const workspace = manager.get_workspace_by_index(index);
            workspace.activate(global.get_current_time()); await delay(200);
            const magnifier = bar._magnifier;
            controls.push({magnifier, pointer: magnifier._checkPointer, menu: magnifier._hasOpenMenu});
            magnifier._checkPointer = () => {}; magnifier._hasOpenMenu = () => true;
            const button = bar._container.get_children().find(button => button.wsIndex === index);
            const source = button._wsbIconsWrapper.get_children().find(icon => icon.windowObj);
            const [sx] = source.get_transformed_position(), [sw] = source.get_transformed_size();
            magnifier._lastPointerX = sx + sw / 2;
            magnifier._setActive(true, true); magnifier._draw(); await delay(100); magnifier._draw();
            const number = magnifier._entries.get(button._wsbNumWrapper), app = magnifier._entries.get(source);
            const [rx] = number.ring.get_transformed_position(), [rw] = number.ring.get_transformed_size();
            const [ax] = app.proxy.get_transformed_position();
            check(`${index === 0 ? 'first' : 'interior'} workspace circle keeps a preset gutter to its own app`, ax - rx - rw >= extension.getPreset().iconSpacing - 0.5);
            if (index === 1) {
                const previous = [...magnifier._entries.values()].find(entry => entry.source.windowObj === windows[0]);
                const [px] = previous.proxy.get_transformed_position(), [pw] = previous.proxy.get_transformed_size();
                check('interior workspace circle keeps space from the preceding app', rx - px - pw >= extension.getPreset().iconSpacing - 0.5);
                duration = 180;
                manager.get_workspace_by_index(0).activate(global.get_current_time()); magnifier._syncEntries();
                check('workspace activation starts the old circle disappearance transition', number.ringTransition?.to === 0);
                workspace.activate(global.get_current_time()); magnifier._syncEntries();
                check('switching back starts the new circle appearance transition', number.ringTransition?.to === 1);
                const [sourceWidth] = number.source.get_transformed_size();
                const ratio = number.canvasWidth / sourceWidth;
                const sample = now => {
                    const insets = magnifier._ordinalInsets(number, sourceWidth, now);
                    if (number.ring.visible) {
                        const [rx] = number.ring.get_transformed_position(), [rw] = number.ring.get_transformed_size();
                        const [cx] = number.content.get_transformed_position(), [cw] = number.content.get_transformed_size();
                        const factor = cw / number.canvasWidth;
                        if (insets.left * ratio > (rx - cx) / factor + 0.01
                            || number.canvasWidth - insets.right * ratio < (rx + rw - cx) / factor - 0.01)
                            throw new Error('animated circle extends beyond its reserved space');
                    }
                    return {width: number.canvasWidth - (insets.left + insets.right) * ratio,
                        amount: number.ringAmount, scale: number.ring.scale_x, opacity: number.ring.opacity};
                };
                const reset = active => {
                    duration = 0; magnifier._setRingActive(number, active); sample(GLib.get_monotonic_time()); duration = 180;
                };
                reset(false);
                let start = GLib.get_monotonic_time();
                magnifier._setRingActive(number, true, start);
                const frames = [0, 45, 90, 135, 180].map(ms => sample(start + ms * 1000));
                check('an appearing circle starts hidden without a spacing jump', frames[0].amount === 0 && frames[0].opacity === 0);
                check('circle size and opacity animate with the configured duration', frames[2].scale === 0.5 && Math.abs(frames[2].opacity - 128) <= 1
                    && frames[4].amount === 1 && !number.ringTransition);
                check('reserved circle space grows smoothly through intermediate widths', frames[2].width > frames[0].width && frames[2].width < frames[4].width
                    && frames.every((frame, i) => i === 0 || frame.width >= frames[i - 1].width));
                start += 180000;
                magnifier._setRingActive(number, false, start);
                const shrink = [0, 90, 180].map(ms => sample(start + ms * 1000));
                check('circle disappearance fades and releases space smoothly', shrink[1].amount === 0.5 && shrink[1].width < shrink[0].width
                    && shrink[1].width > shrink[2].width && shrink[2].amount === 0 && !number.ring.visible);
                reset(false); start = GLib.get_monotonic_time();
                magnifier._setRingActive(number, true, start);
                const halfway = sample(start + 90000);
                magnifier._setRingActive(number, false, start + 90000);
                const reversed = sample(start + 90000), continuing = sample(start + 135000);
                check('rapid workspace changes reverse a circle without jumping', halfway.width === reversed.width && halfway.opacity === reversed.opacity
                    && continuing.amount > 0 && continuing.amount < reversed.amount);
                reset(false); easing = 'ease-out'; start = GLib.get_monotonic_time();
                magnifier._setRingActive(number, true, start);
                check('circle transitions follow the selected easing curve', sample(start + 45000).amount > frames[1].amount);
                reset(false); duration = 360; easing = 'linear'; start = GLib.get_monotonic_time();
                magnifier._setRingActive(number, true, start);
                check('longer transition durations slow both the circle and its space', sample(start + 90000).amount === 0.25);
                duration = 0; sample(start + 90000);
                check('zero transition duration finishes a circle immediately', number.ringAmount === 1 && !number.ringTransition);
                reset(false); desktop.set_boolean('enable-animations', false); await delay(30);
                reset(false); magnifier._setRingActive(number, true); sample(GLib.get_monotonic_time());
                check('disabled GNOME animations finish circle transitions immediately', !St.Settings.get().enable_animations && number.ringAmount === 1 && !number.ringTransition);
                desktop.set_value('enable-animations', animations); duration = 0;
            } else {
                // Independently measure the actual font outline more densely than
                // the runtime cache, so a narrow 1 cannot pass by box centring.
                const context = new Cairo.Context(new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1));
                let sum = 0, mass = 0;
                const ink = number.ordinalInk;
                try {
                    PangoCairo.layout_path(context, number.label.clutter_text.get_layout());
                    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
                        const px = ink.x + (x + 0.5) * ink.width / 128;
                        const py = ink.y + (y + 0.5) * ink.height / 128;
                        if (context.inFill(px, py)) {mass++; sum += px;}
                    }
                } finally {context.$dispose();}
                const inkCenter = number.label.x + sum / mass / number.ordinalResourceScale;
                const ringCenter = number.ring.x + number.ring.width / 2;
                check('the first workspace ring follows the visible stem of digit 1', mass > 0 && Math.abs(inkCenter - ringCenter) <= ink.width / number.ordinalResourceScale * 0.04);
                const inkMiddleY = number.label.y + (ink.y + ink.height / 2) / number.ordinalResourceScale;
                check('digit 1 has equal vertical space above and below inside its ring', Math.abs(inkMiddleY - number.ring.y - number.ring.height / 2) < 0.01);
            }
            magnifier.suspend();
        }
        return results;
    } finally {
        desktop.set_value('enable-animations', animations);
        for (const saved of controls) {saved.magnifier._checkPointer = saved.pointer; saved.magnifier._hasOpenMenu = saved.menu;}
        extension.getMagnificationOptions = original.options;
        windows.forEach((window, i) => window.change_workspace(original.workspaces[i]));
        original.active.activate(global.get_current_time());
        bar._magnifier.suspend(); await delay(350);
    }
}
