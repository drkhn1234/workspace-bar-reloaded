// Import from an isolated shell with a launchable fixture desktop application.
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
export async function checkNewInstance(bar, window) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw new Error('Requires isolated memory settings');
    const results = [], execute = bar._executeGestureAction, settings = bar._gestureSettings;
    const check = (name, valid) => {if (!valid) throw new Error(name); results.push(name);};
    const allWindows = () => global.get_window_actors().map(actor => actor.meta_window);
    const original = new Set(allWindows().map(window => window.get_id()));
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    try {
        bar._executeGestureAction = Object.getPrototypeOf(bar)._executeGestureAction;
        bar._gestureSettings = bar._ext.getSettings();
        check(`fixture app supports the native new-window request (${app?.get_id()}, ${window.get_wm_class()}, ${window.get_gtk_application_id()})`, app?.can_open_new_window());
        check('factory Middle Click selects Open New Instance', bar._gestureSettings.get_string('gesture-app-middle-click') === 'new-instance');
        const icon = bar._container.get_children().flatMap(button => button._wsbIconsWrapper.get_children())
            .find(icon => icon.windowObj === window);
        check('source icon is available for the new-instance gesture', !!icon);
        bar._handleIconClick(icon, Clutter.BUTTON_MIDDLE);
        // The fixture creates two windows per launch. Wait for both mappings so
        // cleanup cannot miss a second window that appears a frame later.
        for (let i = 0; i < 40 && allWindows().filter(window => !original.has(window.get_id())).length < 2; i++) await delay(100);
        const created = allWindows().filter(window => !original.has(window.get_id()));
        check('Middle Click launches additional windows for the clicked application', created.length === 2
            && created.every(window => Shell.WindowTracker.get_default().get_window_app(window)?.get_id() === app.get_id()));
        check('opening a new instance preserves the original window', allWindows().includes(window));
        return results;
    } finally {
        for (const window of allWindows()) if (!original.has(window.get_id())) window.delete(global.get_current_time());
        bar._executeGestureAction = execute;
        bar._gestureSettings = settings;
        await delay(500);
    }
}
