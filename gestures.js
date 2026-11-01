import {DEFAULT_CONFIGURATION} from './defaultConfiguration.js';
const common = [
    ['overview', 'Toggle Overview'], ['move-active', 'Move to Active Workspace'],
    ['close', 'Close Windows'], ['switch-previous', 'Previous Workspace'],
    ['switch-next', 'Next Workspace'], ['move-previous', 'Move to Previous Workspace'],
    ['move-next', 'Move to Next Workspace'], ['none', 'Do Nothing'],
];
export const gestureActions = (kind, input = 'left-click') => [
    ['activate', kind === 'app' ? 'Focus / Show Windows' : 'Activate / Overview'],
    ...(kind === 'app' ? [['new-instance', 'Open New Instance']] : []),
    ['menu', kind === 'app' ? 'Window Menu' : 'Workspace Menu'],
    ...common.slice(0, input.startsWith('scroll-') ? -1 : 3),
    ...(kind === 'workspace' && input.startsWith('scroll-') ? [['reorder-previous', 'Move Workspace Earlier'], ['reorder-next', 'Move Workspace Later']] : []),
    common.at(-1),
].filter(([action]) => kind === 'workspace' || action !== 'overview');
export const horizontalActions = kind => [
    ['move-windows', 'Move Windows'],
    ...(kind === 'workspace' ? [['reorder-workspace', 'Reorder Workspaces']] : []),
    ['none', 'Do Nothing'],
];
export const GESTURE_INPUTS = [
    ['left-click', 'Left Click', 'activate'], ['middle-click', 'Middle Click', 'overview'],
    ['right-click', 'Right Click', 'menu'], ['scroll-up', 'Scroll / Swipe Up', 'move-active'],
    ['scroll-down', 'Scroll / Swipe Down', 'close'], ['horizontal-scroll', 'Horizontal Scroll / Swipe', 'move-windows'],
];
export const gestureDefault = (kind, input) => DEFAULT_CONFIGURATION[`gesture-${kind}-${input}`]
    ?? GESTURE_INPUTS.find(([name]) => name === input)?.[2];

export function migrateGestureSettings(settings) {
    const existed = settings.get_boolean('gesture-settings-migrated');
    if (!existed) {
        if (!settings.get_user_value('gesture-app-middle-click') && settings.get_user_value('middle-click-close'))
            settings.set_string('gesture-app-middle-click', settings.get_boolean('middle-click-close') ? 'close' : 'none');
        settings.set_boolean('gesture-settings-migrated', true);
    }
    const version = settings.get_int('gesture-settings-version');
    if (version >= 3) return;
    // Overview stays accepted by the app schema solely for migration. Keeping
    // it readable avoids turning an old Overview swipe into a default Close.
    for (const [input] of GESTURE_INPUTS) {
        if (input === 'horizontal-scroll') continue;
        const key = `gesture-app-${input}`;
        if (settings.get_string(key) === 'overview') settings.set_string(key, 'none');
    }
    if (version >= 2) {settings.set_int('gesture-settings-version', 3); return;}
    const raw = key => {
        const value = settings.get_user_value(key);
        return value?.deep_unpack?.() ?? value;
    };
    const horizontal = ['app', 'workspace'].map(kind => [kind, raw(`gesture-${kind}-horizontal-scroll`)]);
    const customized = horizontal.some(([, value]) => ['move-windows', 'reorder-workspace', 'none'].includes(value));
    if (!settings.get_user_value('gesture-horizontal-switch-workspaces')
        && (existed || horizontal.some(([, value]) => value != null)))
        settings.set_boolean('gesture-horizontal-switch-workspaces', !customized);
    for (const [kind, value] of horizontal) {
        if (!horizontalActions(kind).some(([action]) => action === value)) {
            if (customized && existed) settings.set_string(`gesture-${kind}-horizontal-scroll`, 'none');
            else settings.reset(`gesture-${kind}-horizontal-scroll`);
        }
        for (const input of ['left-click', 'middle-click', 'right-click']) {
            const key = `gesture-${kind}-${input}`, previous = raw(key);
            if (previous && !gestureActions(kind, input).some(([action]) => action === previous)) settings.reset(key);
        }
    }
    settings.set_int('gesture-settings-version', 3);
}

export const horizontalGestureAction = (mode, direction) => {
    const side = direction === 'left' ? 'previous' : 'next';
    return {'move-windows': `move-${side}`, 'reorder-workspace': `reorder-${side}`, none: 'none'}[mode] ?? 'none';
};

export function horizontalSwipeDirection(direction, {touchpad, natural, switching, affectSwitching, affectMovement}) {
    if (!touchpad || !natural || !(switching ? affectSwitching : affectMovement)) return direction;
    return direction === 'left' ? 'right' : direction === 'right' ? 'left' : direction;
}

// Keep the initial target throughout a gesture. Vertical actions run once;
// horizontal distance and momentum produce further steps on that same target.
export class ScrollGestureTracker {
    constructor() {this.reset(); this.lastWheel = -Infinity;}
    reset() {this.dx = 0; this.dy = 0; this.lastTime = -Infinity; this.started = false; this.locked = false; this.axis = null; this.target = null; this.workspaceCount = null;}
    feed({dx, dy, time, target, discrete = false, finished = false, touchpad = false, inverted = false}) {
        if (finished) {this.reset(); return null;}
        if (touchpad && inverted) {dx = -dx; dy = -dy;}
        if (!Number.isFinite(dx + dy) || !dx && !dy) return null;
        if (discrete) {
            if (time - this.lastWheel < 180) return null;
            this.lastWheel = time;
            return {direction: Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down'), target};
        }
        if (time - this.lastTime > 350) this.reset();
        this.lastTime = time;
        if (!this.started) {this.started = true; this.target = target;}
        if (this.axis === 'vertical') return null;
        this.dx += dx; this.dy += dy;
        if (!this.axis) {
            if (Math.max(Math.abs(this.dx), Math.abs(this.dy)) < 1) return null;
            this.axis = Math.abs(this.dx) > Math.abs(this.dy) ? 'horizontal' : 'vertical';
            if (this.axis === 'vertical') {
                this.locked = true;
                return {direction: this.dy < 0 ? 'up' : 'down', target: this.target};
            }
        }
        // The first step is responsive; subsequent steps require four scroll
        // units (about 40 touchpad pixels). Keep fractional motion and inertia.
        const distance = Math.abs(this.dx), threshold = this.locked ? 4 : 1;
        if (distance < threshold) return null;
        const steps = this.locked ? Math.floor(distance / 4) : 1 + Math.floor((distance - 1) / 4);
        const sign = Math.sign(this.dx);
        this.dx -= sign * (this.locked ? steps * 4 : 1 + (steps - 1) * 4);
        this.locked = true;
        return {direction: sign < 0 ? 'left' : 'right', target: this.target, ...(steps > 1 ? {steps} : {})};
    }
}

// Native window operations are kept separate from event handling and UI actions.
export function runWindowGesture(action, {windows, workspace, manager, time}) {
    if (action === 'none') return true;
    if (action === 'close') {
        for (const window of new Set(windows)) if (window.get_workspace() && window.can_close?.() !== false) window.delete(time);
        return true;
    }
    const previous = action.endsWith('previous'), step = previous ? -1 : 1;
    const count = manager.get_n_workspaces();
    if (action.startsWith('switch-')) {
        const index = manager.get_active_workspace_index() + step;
        if (index >= 0 && index < count) manager.get_workspace_by_index(index)?.activate(time);
        return true;
    }
    if (action.startsWith('reorder-')) {
        const sourceIndex = workspace?.index();
        if (!(sourceIndex >= 0 && sourceIndex < count)) return true;
        const index = sourceIndex + step;
        if (index >= 0 && index < count) manager.reorder_workspace(workspace, index);
        return true;
    }
    if (action === 'move-active' || action.startsWith('move-')) {
        if (action !== 'move-active' && !(workspace?.index() >= 0)) return true;
        const index = action === 'move-active' ? manager.get_active_workspace_index() : workspace?.index() + step;
        if (!(index >= 0 && index < count)) return true;
        const destination = manager.get_workspace_by_index(index);
        if (destination) for (const window of new Set(windows)) {
            if (!window.get_workspace()) continue;
            if (window.is_on_all_workspaces?.()) window.unstick();
            if (window.get_workspace() !== destination) window.change_workspace(destination);
        }
        return true;
    }
    return false;
}
