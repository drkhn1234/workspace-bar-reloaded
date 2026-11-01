import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspaceRetentionPolicy, withPreservedWorkspaces, cancelQueuedWorkspaceCheck} from './workspaceRetentionPolicy.js';

// Temporarily preserve empty gaps, then let GNOME's own tracker remove them.
// Active workspaces, native keep-alives and the trailing spare remain native.
export function installWorkspaceRetention(settings) {
    const injections = new InjectionManager(), tracker = Main.wm._workspaceTracker;
    if (!tracker) return injections;
    const policy = new WorkspaceRetentionPolicy(), manager = global.workspace_manager;
    const windowSignals = new Map();
    let timer = 0, timerDeadline = null, disposed = false;
    const workspaces = () => Array.from({length: manager.n_workspaces}, (_, i) => manager.get_workspace_by_index(i));
    const cancelTimer = () => {
        if (timer) GLib.Source.remove(timer);
        timer = 0; timerDeadline = null;
    };
    const queueCheck = () => {if (!disposed) tracker._queueCheckWorkspaces();};
    const schedule = deadline => {
        if (deadline === timerDeadline) return;
        cancelTimer();
        if (deadline === null) return;
        timerDeadline = deadline;
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.ceil(deadline - GLib.get_monotonic_time() / 1000)), () => {
            timer = 0; timerDeadline = null; queueCheck();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(timer, '[workspace-bar] empty workspace cooldown');
    };
    const watchWorkspaces = () => {
        if (disposed) return;
        const present = new Set(workspaces());
        for (const [workspace, id] of windowSignals) {
            if (present.has(workspace)) continue;
            workspace.disconnect(id); windowSignals.delete(workspace); policy.filled(workspace);
        }
        for (const workspace of present) {
            if (windowSignals.has(workspace)) continue;
            // Reset immediately, including brief placements between native checks.
            windowSignals.set(workspace, workspace.connect('window-added', (_workspace, window) => {
                if (!window.is_on_all_workspaces()) policy.filled(workspace);
                queueCheck();
            }));
        }
    };
    watchWorkspaces();
    const managerId = manager.connect('notify::n-workspaces', watchWorkspaces);
    const settingsId = settings.connect('changed::empty-workspace-cooldown', queueCheck);
    injections.overrideMethod(tracker, '_checkWorkspaces', original => function (...args) {
        if (disposed) return original.apply(this, args);
        if (!Meta.prefs_get_dynamic_workspaces()) {
            policy.clear(); cancelTimer();
            return original.apply(this, args);
        }
        if (this._pauseWorkspaceCheck) return original.apply(this, args);
        const occupied = new Set();
        for (const actor of global.get_window_actors()) {
            const window = actor.get_meta_window();
            if (!window || window.is_on_all_workspaces()) continue;
            const workspace = window.get_workspace();
            if (workspace) occupied.add(workspace);
        }
        const result = policy.evaluate(workspaces(), occupied, GLib.get_monotonic_time() / 1000,
            settings.get_int('empty-workspace-cooldown') * 1000);
        schedule(result.nextExpiry);
        return withPreservedWorkspaces(result.preserved, () => original.apply(this, args));
    });
    cancelQueuedWorkspaceCheck(tracker, global.compositor.get_laters());
    queueCheck();
    return {
        clear() {
            if (disposed) return;
            disposed = true; cancelTimer(); policy.clear();
            cancelQueuedWorkspaceCheck(tracker, global.compositor.get_laters());
            settings.disconnect(settingsId); manager.disconnect(managerId);
            for (const [workspace, id] of windowSignals) workspace.disconnect(id);
            windowSignals.clear(); injections.clear();
        },
    };
}
