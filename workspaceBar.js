import Meta from "gi://Meta";
import St from "gi://St";
import Shell from "gi://Shell";
import Clutter from "gi://Clutter";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as DND from "resource:///org/gnome/shell/ui/dnd.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as WindowMenu from "resource:///org/gnome/shell/ui/windowMenu.js";
import { gettext as _, InjectionManager } from "resource:///org/gnome/shell/extensions/extension.js";
import { computePanelLayout } from "./panelLayout.js";
import DockMagnifier from "./dockMagnifier.js";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Pango from "gi://Pango";
import {migrateGestureSettings, ScrollGestureTracker, horizontalGestureAction, runWindowGesture} from './gestures.js';

const ICON_TIMEOUT = 200;
const GAP_HALF_WIDTH = 15;

// Slow-motion multiplier for inspecting animations during development (1 = normal).
const ANIM_SLOWMO = 1;

const FOCUS_ANIM_DURATION_MS = 200;
const POPUP_ANIM_MS = 150;
const DIM_INACTIVE_OPACITY = 128;
const DESATURATE_EFFECT_NAME = 'wsb-desaturate';

// Press interval threshold before a touch sequence initiates a drag (ms).
// A longer threshold prevents accidental drags during taps while keeping touch drag responsive.
const TOUCH_DND_TIMEOUT_THRESHOLD = 400;

// Long-press duration for touch context menu (ms). Must exceed TOUCH_DND_TIMEOUT_THRESHOLD
// so dragging initiates before context menus pop up during touch-and-drag.
const TOUCH_LONG_PRESS_DURATION_MS = 600;

// Midpoint of the 0-255 luma range: an inherited panel foreground darker than
// this means the panel is drawing dark text over a bright background.
const FG_DARK_LUMA_THRESHOLD = 128;

const ARROW_STRIP_WIDTH = 14;
const OVERFLOW_TOLERANCE = 4;
const SYNC_DEBOUNCE_MS = 50;
const SYNC_RETRY_MS = 120;
const SCROLL_SCHEDULE_MS = 30;
const SCROLL_RETRY_MS = 80;
const VIEWPORT_INIT_DELAY_MS = 100;

export default class WorkspaceBar {
    constructor(ext) {
        this._ext = ext;
        this._destroyed = false;
        // Gap-drop animation state — kept on the instance (NOT reset in _setup) so
        // it survives the deferred rebuild that runs between drop and animation.
        this._gapDropInProgress = false;
        this._pendingGapAnim = null;
        this._reorderFlip = null;
        this._scrollGesture = new ScrollGestureTracker();
        this._scrollCaptureId = null;
        this._scrollCaptureTimeout = 0;
        this._setup();
    }

    _setup() {
        this._container = null;
        this._clip = null;
        this._viewport = null;
        this._arrowLeft = null;
        this._arrowRight = null;
        this._winIdsRepr = []; // [ws0[winId, winId], ws1[winId], ...]  — primary assignment only
        this._stickyListenerIds = new Map(); // winId -> { windowObj, signalId } for notify::on-all-workspaces
        this._stickyReconcileId = null;
        this._rebuildId = null;
        this._gnomeEventIds = { display: [], workspace_manager: [] };
        this._mainEventIds = { layoutManager: [], panel: [], overview: [] };
        this._glibTimeoutIds = new Set();
        this._gapDragMonitor = null;
        this._insertionIndicator = null;
        this._currentInsertIndex = -1;
        this._gapDropWindows = null;
        this._scrollOffset = 0;
        this._availableWidth = null;
        this._panelWidthUpdateId = null;
        this._panelLayoutInjections = null;
        this._syncPending = false;
        this._focusedWindowId = global.display.get_focus_window()?.get_id() ?? null;
        this._menuManager = null;
        this._contextMenu = null;
        this._windowContextMenu = null;
        this._lastHandledIconTime = 0;
        this._windowPopup = null;
        this._popupLeader = null;
        this._popupCapturedId = null;
        this._popupRefreshPending = false;
        this._magnifier = null;
        this._gestureSettings = this._ext.getSettings();
        // A running shell may still hold the schema from before an update.
        if (!this._gestureSettings.settings_schema.has_key('gesture-horizontal-switch-workspaces')
            || this._gestureSettings.get_default_value('gesture-app-middle-click').deep_unpack() !== 'new-instance') {
            const source = Gio.SettingsSchemaSource.new_from_directory(`${this._ext.path}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
            this._gestureSettings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.workspace-bar', false)});
        }
        migrateGestureSettings(this._gestureSettings);

        this._createContainer();
        this._insertContainer();
        this._initialPopulation();
        this._connectSignals();
        this._magnifier = new DockMagnifier(this);

        this._scheduleTimeout(VIEWPORT_INIT_DELAY_MS, () => this._updateAvailableWidth());
    }

    destroy(full = true) {
        this._destroyed = true;
        if (full) this._endScrollCapture();
        if (this._rebuildId) {
            global.compositor.get_laters().remove(this._rebuildId);
            this._rebuildId = null;
        }
        this._magnifier?.destroy();
        this._magnifier = null;
        this._panelLayoutInjections?.clear();
        this._panelLayoutInjections = null;
        this._unregisterGapDragMonitor();
        this._closeWindowPopup();

        if (this._viewport) {
            this._removeContainer();
            this._viewport.destroy();
            this._viewport = null;
            this._clip = null;
            this._container = null;
            this._arrowLeft = null;
            this._arrowRight = null;
        }

        // Disconnect GNOME signals
        for (let component in this._gnomeEventIds) {
            let obj = component === 'display' || component === 'workspace_manager'
                ? global[component] : Main[component];
            for (let id of this._gnomeEventIds[component]) {
                obj.disconnect(id);
            }
        }
        this._gnomeEventIds = null;

        for (let component in this._mainEventIds) {
            for (let id of this._mainEventIds[component]) {
                Main[component].disconnect(id);
            }
        }
        this._mainEventIds = null;

        // Clear timeouts
        for (let timeoutId of this._glibTimeoutIds) {
            GLib.Source.remove(timeoutId);
        }
        this._glibTimeoutIds.clear();
        this._glibTimeoutIds = null;

        // Clean up window-added events on workspaces
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            let wsObj = global.workspace_manager.get_workspace_by_index(i);
            if (wsObj.hasOwnProperty("_wsbWindowAddedId")) {
                wsObj.disconnect(wsObj._wsbWindowAddedId);
                delete wsObj._wsbWindowAddedId;
            }
        }

        // Disconnect per-window sticky listeners
        if (this._stickyListenerIds) {
            for (let entry of this._stickyListenerIds.values()) {
                try { entry.windowObj.disconnect(entry.signalId); } catch (_e) {}
            }
            this._stickyListenerIds.clear();
            this._stickyListenerIds = null;
        }

        this._winIdsRepr = null;

        if (this._contextMenu) { this._contextMenu.destroy(); this._contextMenu = null; }
        if (this._windowContextMenu) { this._windowContextMenu.destroy(); this._windowContextMenu = null; }
        this._menuManager = null;

        if (full) {
            this._ext = null;
        } else {
            this._destroyed = false;
        }
    }

    // ===================== CONTAINER =====================

    _createContainer() {
        this._container = new St.BoxLayout({
            style_class: "wsb-container-wrapper",
            reactive: true,
            track_hover: true,
            x_expand: false,
            y_expand: false,
        });

        this._clip = new St.Widget({
            reactive: true,
            clip_to_allocation: true,
            x_expand: false,
            y_expand: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._clip.add_child(this._container);

        this._viewport = new St.Widget({
            reactive: true,
            clip_to_allocation: true,
            x_expand: false,
            y_expand: true,
            min_width: 0,
            natural_width: 0,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._viewport.add_child(this._clip);

        this._arrowLeft = new St.Label({
            text: '◂',
            style_class: "wsb-overflow-arrow",
            reactive: false,
            can_focus: false,
            visible: false,
        });
        this._arrowRight = new St.Label({
            text: '▸',
            style_class: "wsb-overflow-arrow",
            reactive: false,
            can_focus: false,
            visible: false,
        });
        this._viewport.add_child(this._arrowLeft);
        this._viewport.add_child(this._arrowRight);

        this._viewport.connect('notify::width', () => {
            this._updateOverlays();
            this._scheduleScrollToActive();
        });
        this._viewport.connect('notify::height', () => this._updateOverlays());
        this._viewport.connect('scroll-event', (_actor, event) => this._onScrollEvent(event));

        this._chromeVariant = null;
        this._shadowClass = null;
        this._viewport.connect('style-changed', () => this._updateChromeVariant());
    }

    // The stylesheet's default chrome assumes the stock panel: light text over
    // a dark background. Watch the foreground color the panel cascades down and
    // pick the variant class that matches reality. Re-entrant style-changed
    // emissions from the class swap are cut short by the equality check.
    _updateChromeVariant() {
        if (!this._viewport || this._destroyed) return;
        let node = this._viewport.peek_theme_node();
        if (!node) return;

        let fg = node.get_foreground_color();
        let luma = 0.2126 * fg.red + 0.7152 * fg.green + 0.0722 * fg.blue;
        let fgIsDark = luma < FG_DARK_LUMA_THRESHOLD;

        let variant = fgIsDark ? 'wsb-chrome-dark' : null;

        let shadow = this._ext.getLegibilityShadows()
            ? (fgIsDark ? 'wsb-shadows-light' : 'wsb-shadows-dark')
            : null;

        if (variant !== this._chromeVariant) {
            if (this._chromeVariant) this._viewport.remove_style_class_name(this._chromeVariant);
            if (variant) this._viewport.add_style_class_name(variant);
            this._chromeVariant = variant;
        }
        if (shadow !== this._shadowClass) {
            if (this._shadowClass) this._viewport.remove_style_class_name(this._shadowClass);
            if (shadow) this._viewport.add_style_class_name(shadow);
            this._shadowClass = shadow;
        }
    }

    onLegibilityShadowsChanged() {
        this._updateChromeVariant();
    }

    _onScrollEvent(event) {
        // Mutter also emits compatibility wheel events for smooth scrolling.
        if (event.is_pointer_emulated?.()) return Clutter.EVENT_STOP;
        if (this._magnifier?._dragging) return Clutter.EVENT_STOP;
        const direction = event.get_scroll_direction();
        const smooth = direction === Clutter.ScrollDirection.SMOOTH;
        const deltas = {[Clutter.ScrollDirection.UP]: [0, -1], [Clutter.ScrollDirection.DOWN]: [0, 1],
            [Clutter.ScrollDirection.LEFT]: [-1, 0], [Clutter.ScrollDirection.RIGHT]: [1, 0]};
        const [dx, dy] = smooth ? event.get_scroll_delta() : deltas[direction] ?? [0, 0];
        if (smooth && (!dx && !dy || event.get_scroll_finish_flags?.())) {
            this._endScrollCapture(); return Clutter.EVENT_STOP;
        }
        if (smooth) this._captureScrollStream();
        const touchpad = event.get_scroll_source?.() === Clutter.ScrollSource.FINGER;
        const inverted = touchpad && (event.get_scroll_flags
            ? !!(event.get_scroll_flags() & Clutter.ScrollFlags.INVERTED)
            : (this._touchpadSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.touchpad'})).get_boolean('natural-scroll'));
        const time = GLib.get_monotonic_time() / 1000;
        const continuing = smooth && this._scrollGesture.started && time - this._scrollGesture.lastTime <= 350;
        const gesture = this._scrollGesture.feed({dx, dy, discrete: !smooth, touchpad, inverted, time,
            target: continuing ? this._scrollGesture.target : this._gestureTargetAt(event)});
        if (!gesture) return Clutter.EVENT_STOP;
        const {target} = gesture, horizontal = ['left', 'right'].includes(gesture.direction);
        let action;
        if (horizontal) {
            action = this._gestureSettings.get_boolean('gesture-horizontal-switch-workspaces')
                ? `switch-${gesture.direction === 'left' ? 'previous' : 'next'}`
                : target.kind === 'bar' ? 'none' : horizontalGestureAction(
                    this._gestureSettings.get_string(`gesture-${target.kind}-horizontal-scroll`), gesture.direction);
        } else if (target.kind === 'bar') action = gesture.direction === 'up' ? 'switch-previous' : 'switch-next';
        else action = this._gestureSettings.get_string(`gesture-${target.kind}-scroll-${gesture.direction}`);
        const manager = global.workspace_manager;
        const workspaceCount = horizontal && smooth
            ? this._scrollGesture.workspaceCount ??= manager.get_n_workspaces() : manager.get_n_workspaces();
        for (let step = 0; step < Math.min(gesture.steps ?? 1, workspaceCount); step++) {
            const index = action.startsWith('switch-') ? manager.get_active_workspace_index() : target.workspace?.index();
            const destinationIndex = index + (gesture.direction === 'left' ? -1 : 1);
            // A move into GNOME's empty spare can create another spare. Keep a
            // single swipe within the workspace list that existed at its start.
            if (horizontal && (action.startsWith('switch-') || action.startsWith('move-') || action.startsWith('reorder-'))
                && destinationIndex >= workspaceCount && workspaceCount < manager.get_n_workspaces()) break;
            const destination = horizontal && action.startsWith('move-') && index >= 0
                && destinationIndex >= 0 && destinationIndex < manager.get_n_workspaces()
                ? manager.get_workspace_by_index(destinationIndex) : null;
            this._executeGestureAction(target, action);
            if (destination) target.workspace = destination;
        }
        return Clutter.EVENT_STOP;
    }

    _captureScrollStream() {
        // Consume the rest of a touchpad gesture even after its target disappears.
        if (this._scrollCaptureId === null) this._scrollCaptureId = global.stage.connect('captured-event', (_stage, event) =>
            event.type() === Clutter.EventType.SCROLL ? this._onScrollEvent(event) : Clutter.EVENT_PROPAGATE);
        if (this._scrollCaptureTimeout) {
            GLib.Source.remove(this._scrollCaptureTimeout);
        }
        // This stream outlives a bar rebuild when a move/reorder changes its
        // actors. Only gesture end, inactivity or full teardown releases it.
        this._scrollCaptureTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._scrollCaptureTimeout = 0; this._endScrollCapture();
            return GLib.SOURCE_REMOVE;
        });
    }

    _endScrollCapture() {
        if (this._scrollCaptureId !== null && this._scrollCaptureId !== undefined) global.stage.disconnect(this._scrollCaptureId);
        this._scrollCaptureId = null;
        if (this._scrollCaptureTimeout) {
            GLib.Source.remove(this._scrollCaptureTimeout);
        }
        this._scrollCaptureTimeout = 0; this._scrollGesture?.reset();
    }

    _gestureTarget(actor) {
        if (actor?.windowObj) return {kind: 'app', actor, window: actor.windowObj,
            windows: actor._wsbPopupRow ? [actor.windowObj] : this._getGroupWindows(actor), workspace: actor.windowObj.get_workspace()};
        const button = actor?._wsbWorkspaceButton ?? actor;
        if (button?.wsIndex !== undefined) return {kind: 'workspace', actor: button,
            workspace: global.workspace_manager.get_workspace_by_index(button.wsIndex), windows: this._getWorkspaceWindows(button.wsIndex)};
        return {kind: 'bar', windows: [], workspace: null};
    }

    _gestureTargetAt(event) {
        const [x, y] = event.get_coords();
        for (const entry of this._magnifier?._entries.values() ?? [])
            if (entry.source && entry.proxy.visible && entry.proxy.opacity > 0 && (this._actorContainsPoint(entry.proxy, x, y)
                || entry.panelTarget?.reactive && this._actorContainsPoint(entry.panelTarget, x, y)))
                return this._gestureTarget(entry.source);
        for (let actor = event.get_source(); actor; actor = actor.get_parent()) {
            if (actor.windowObj || actor._wsbWorkspaceButton || actor.wsIndex !== undefined) return this._gestureTarget(actor);
            if (actor === this._viewport) break;
        }
        for (const button of this._container.get_children()) {
            for (const icon of button._wsbIconsWrapper?.get_children() ?? [])
                if (icon.visible && this._actorContainsPoint(icon, x, y)) return this._gestureTarget(icon);
            if (button.visible && this._actorContainsPoint(button, x, y)) return this._gestureTarget(button);
        }
        return this._gestureTarget(null);
    }

    _handleWorkspaceClick(button, mouseButton) {
        const input = this._clickInput(mouseButton);
        if (!input) return Clutter.EVENT_PROPAGATE;
        this._executeGestureAction(this._gestureTarget(button), this._gestureSettings.get_string(`gesture-workspace-${input}`));
        return Clutter.EVENT_STOP;
    }

    _clickInput(button) {
        return ({0: 'left-click', [Clutter.BUTTON_PRIMARY]: 'left-click',
            [Clutter.BUTTON_MIDDLE]: 'middle-click', [Clutter.BUTTON_SECONDARY]: 'right-click'})[button];
    }

    _executeGestureAction(target, action) {
        if (action === 'none') return;
        if (action === 'new-instance') {
            if (target.kind !== 'app' || !target.window) return;
            const app = Shell.WindowTracker.get_default().get_window_app(target.window);
            if (!app) return;
            this._closeWindowPopup();
            if (app.can_open_new_window()) app.open_new_window(-1);
            else app.activate();
            Main.overview.hide();
            return;
        }
        if (action === 'overview') {
            if (target.kind !== 'workspace' || !(target.workspace?.index() >= 0)) return;
            // Starting Overview first prevents its initialization from restoring
            // the previously active workspace during the opening animation.
            Main.overview.toggle();
            target.workspace.activate(global.get_current_time());
            return;
        }
        if (action === 'menu') {
            if (target.kind === 'app') this._openWindowContextMenu(target.actor, target.window, target.windows);
            else if (target.kind === 'workspace') this._openContextMenu(target.actor);
            return;
        }
        if (action === 'activate') {
            if (target.kind === 'workspace') {
                if (target.workspace?.index() === global.workspace_manager.get_active_workspace_index()) Main.overview.toggle();
                else target.workspace?.activate(global.get_current_time());
            } else if (target.window) {
                if (target.windows.length >= 2) this._toggleWindowPopup(target.actor);
                else if (Main.overview.visible && global.display.get_focus_window() === target.window) Main.overview.hide();
                else Main.activateWindow(target.window);
            }
            return;
        }
        this._magnifier?.suspend(); this._closeWindowPopup();
        if (runWindowGesture(action, {...target, manager: global.workspace_manager, time: global.get_current_time()})) {
            if (action.startsWith('switch-')) this._scheduleScrollToActive();
            else {this._scheduleWorkspaceCleanup(); this._scheduleStickyReconcile(); this._scheduleRebuild();}
        }
    }

    _insertContainer() {
        let pos = this._ext.getPosition();
        let posIndex = this._ext.getPositionIndex();
        let box;
        if (pos === 'center') box = Main.panel._centerBox;
        else if (pos === 'right') box = Main.panel._rightBox;
        else box = Main.panel._leftBox;

        let maxIndex = box.get_n_children();
        box.insert_child_at_index(this._viewport, Math.min(posIndex, maxIndex));
    }

    _removeContainer() {
        let parent = this._viewport.get_parent();
        if (parent) parent.remove_child(this._viewport);
    }

    onPositionChanged() {
        if (!this._viewport) return;
        this._removeContainer();
        this._insertContainer();
        this._updateAvailableWidth();
    }

    onSizeModeChanged() {
        if (!this._container) return;
        this._magnifier?.suspend();
        this._regenerateIcons();
    }

    onMagnificationSettingsChanged(rebuild = false) {
        this._magnifier?.settingsChanged(rebuild);
    }

    // Single entry point for every setting that changes how icons are drawn
    // per focus state: scale, dim and desaturation all invalidate the same way.
    onIconEffectsChanged() {
        this._refreshAllIconEffects(true);
    }

    // ===================== FOCUS-DEPENDENT ICON EFFECTS =====================

    _onFocusWindowChanged() {
        if (!this._container) return;
        let focusedId = global.display.get_focus_window()?.get_id() ?? null;
        if (focusedId === this._focusedWindowId) return;
        this._focusedWindowId = focusedId;
        this._refreshAllIconEffects(true);
    }

    _refreshAllIconEffects(animate) {
        if (!this._container) return;
        for (let btn of this._container.get_children()) {
            let iconsWrapper = btn._wsbIconsWrapper;
            if (!iconsWrapper) continue;
            for (let iconWrapper of iconsWrapper.get_children()) {
                this._applyIconEffects(iconWrapper, animate);
            }
        }
    }

    _applyIconEffects(wrapper, animate) {
        let iconTex = wrapper._iconTex;
        if (!iconTex) return;

        // A combined icon counts as focused when ANY of its windows is focused,
        // not just the one it happens to be drawn from.
        let isFocused = wrapper.windowId === this._focusedWindowId ||
            (wrapper._wsbGroupIds?.includes(this._focusedWindowId) ?? false);
        let animated = animate && this._ext.getEnableAnimations();

        let scaleEnabled = this._ext.getFocusScaleEffect();
        let reduction = Math.max(0, Math.min(95, this._ext.getFocusScaleReduction())) / 100;
        let scale = (!scaleEnabled || isFocused) ? 1.0 : (1 - reduction);

        // Dim rides on the icon texture, never on the wrapper: the wrapper's own
        // opacity is already spoken for by the pop-in/fade-out animations and by
        // the drag-begin feedback. Clutter composes the two, so both keep working.
        let dimmed = this._ext.getDimInactiveIcons() && !isFocused;
        let opacity = dimmed ? DIM_INACTIVE_OPACITY : 255;

        if (animated) {
            iconTex.ease({
                scale_x: scale,
                scale_y: scale,
                opacity,
                duration: FOCUS_ANIM_DURATION_MS * ANIM_SLOWMO,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            iconTex.scale_x = scale;
            iconTex.scale_y = scale;
            iconTex.opacity = opacity;
        }

        this._applyIconDesaturation(iconTex, isFocused, animated);
    }

    // Grayscale for every icon except the focused one. The shader is attached
    // only while the setting is on and removed as soon as it goes off, so in the
    // default configuration no icon carries an effect at all.
    _applyIconDesaturation(iconTex, isFocused, animated) {
        let effect = iconTex.get_effect(DESATURATE_EFFECT_NAME);

        if (!this._ext.getDesaturateInactiveIcons()) {
            if (effect) iconTex.remove_effect(effect);
            return;
        }

        if (!effect) {
            effect = new Clutter.DesaturateEffect({ factor: 0 });
            iconTex.add_effect_with_name(DESATURATE_EFFECT_NAME, effect);
        }

        let factor = isFocused ? 0 : 1;
        if (animated) {
            iconTex.ease_property(`@effects.${DESATURATE_EFFECT_NAME}.factor`, factor, {
                duration: FOCUS_ANIM_DURATION_MS * ANIM_SLOWMO,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            effect.factor = factor;
        }
    }

    // ===================== OVERFLOW HANDLING =====================

    _scheduleTimeout(ms, callback) {
        if (this._destroyed) return 0;
        let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._glibTimeoutIds?.delete(id);
            if (!this._destroyed) callback();
            return GLib.SOURCE_REMOVE;
        });
        this._glibTimeoutIds.add(id);
        return id;
    }

    _measurePanelLayout(panelWidth = Main.panel.get_width(), centerPoint) {
        if (!this._viewport || this._destroyed || panelWidth <= 0) return null;
        const panel = Main.panel;
        const boxes = [panel._leftBox, panel._centerBox, panel._rightBox];
        const viewportBox = boxes.indexOf(this._viewport.get_parent());
        if (viewportBox < 0) return null;

        const naturalWidths = boxes.map(box => box.visible
            ? box.get_preferred_width(-1)[1] : 0);
        const viewportWidth = this._viewport.visible && boxes[viewportBox].visible
            ? this._viewport.get_preferred_width(-1)[1] : 0;
        return computePanelLayout({
            panelWidth, naturalWidths, viewportWidth, viewportBox, centerPoint,
            rtl: panel.get_text_direction() === Clutter.TextDirection.RTL,
        });
    }

    _updateAvailableWidth() {
        const layout = this._measurePanelLayout();
        if (!layout) return;
        this._availableWidth = layout.availableWidth;
        this._applyViewportWidth();
    }

    _queueAvailableWidthUpdate() {
        if (this._destroyed || this._panelWidthUpdateId !== null) return;
        this._panelWidthUpdateId = this._scheduleTimeout(0, () => {
            this._panelWidthUpdateId = null;
            this._updateAvailableWidth();
        });
    }

    _connectPanelLayout() {
        const bar = this;
        this._panelLayoutInjections = new InjectionManager();
        this._panelLayoutInjections.overrideMethod(
            Object.getPrototypeOf(Main.panel), 'vfunc_allocate', original => function (box) {
                if (this !== Main.panel || bar._destroyed || !bar._allocatePanelSpace(box)) {
                    original.call(this, box);
                    return;
                }
                // Allocation also runs when panel items are added, hidden or
                // resized. Re-measure after layout, and only change the bar's
                // preferred width if needed, to avoid a relayout feedback loop.
                bar._queueAvailableWidthUpdate();
            });
    }

    _allocatePanelSpace(box) {
        const panel = Main.panel;
        const panelWidth = box.x2 - box.x1;
        const panelHeight = box.y2 - box.y1;
        let centerPoint = panelWidth / 2;
        const monitor = Main.layoutManager.findMonitorForActor(panel);
        if (monitor) {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
            centerPoint += (2 * (workArea.x - monitor.x)
                + workArea.width - monitor.width) / 2;
        }
        const layout = this._measurePanelLayout(panelWidth, centerPoint);
        if (!layout) return false;

        // Allocate each group once. Allocating the stock, squeezed layout and
        // then reallocating it can leave children's layout requests pending.
        panel.set_allocation(box);
        const boxes = [panel._leftBox, panel._centerBox, panel._rightBox];
        for (let i = 0; i < boxes.length; i++) {
            const allocation = new Clutter.ActorBox();
            const [x1, x2] = layout.bounds[i].map(Math.round);
            allocation.x1 = x1;
            allocation.x2 = x2;
            allocation.y1 = 0;
            allocation.y2 = panelHeight;
            boxes[i].allocate(allocation);
        }
        return true;
    }

    _applyViewportWidth() {
        if (!this._viewport || !this._container || this._destroyed) return;

        let contentW = this._container.get_width();
        let avail = this._availableWidth ?? this._measurePanelLayout()?.availableWidth ?? 0;

        // Without arrow strips reserved: natural content.
        // When that exceeds the budget, fall back to the budget and let
        // _updateOverlays reserve the strips and enable scrolling.
        let desired = contentW;
        let w = Math.max(0, Math.min(desired, avail));

        // A natural width allows St.BoxLayout to shrink the viewport on the
        // same frame that a neighbouring widget grows. A fixed minimum/CSS
        // width would let icons spill over that widget until the next update.
        if (this._viewport.natural_width !== w)
            this._viewport.natural_width = w;
        this._updateOverlays();
    }

    _scheduleSync() {
        if (this._destroyed || this._syncPending) return;
        // Size the container to its content IMMEDIATELY so a just-added cell/icon
        // isn't crammed into the previous (now-too-small) fixed width — that brief
        // horizontal squeeze (numbers vanishing) flashed before every animation.
        // The debounced _syncContainerWidth below re-applies the proper width/overflow.
        if (this._container) this._container.set_width(-1);
        this._syncPending = true;
        this._scheduleTimeout(SYNC_DEBOUNCE_MS, () => {
            this._syncPending = false;
            this._syncContainerWidth();
        });
    }

    _syncContainerWidth() {
        if (!this._container || this._destroyed) return;

        let children = this._container.get_children();
        if (children.length === 0) {
            this._container.set_width(-1);
            this._applyViewportWidth();
            return;
        }

        let total = 0;
        let hasPending = false;
        for (let c of children) {
            let [, natW] = c.get_preferred_width(-1);
            if (natW <= 0) hasPending = true;
            total += natW;
        }

        let preset = this._ext.getPreset();
        let minExpected = children.length * (preset.iconSize + preset.numSpacing * 2 + 8);
        if (hasPending || total < minExpected) {
            this._scheduleTimeout(SYNC_RETRY_MS, () => this._syncContainerWidth());
            return;
        }

        let realW = this._realContentWidth();
        if (realW > 0 && Math.abs(realW - total) <= 2) {
            total = realW;
        }

        this._container.set_width(total);
        this._applyViewportWidth();
    }

    _realContentWidth() {
        if (!this._container) return 0;
        let children = this._container.get_children();
        if (children.length === 0) return 0;
        let last = children[children.length - 1].get_allocation_box();
        return Math.round(last.x2);
    }

    _setScrollOffset(offset) {
        if (!this._viewport || !this._container || !this._clip || this._destroyed) return;

        let innerW = this._clip.get_width();
        if (innerW <= 0) return;

        let contentW = this._realContentWidth();
        let maxOffset = Math.max(0, contentW - innerW);
        this._scrollOffset = Math.max(0, Math.min(maxOffset, offset));
        this._container.set_x(-this._scrollOffset);
        this._updateOverlays();
    }

    _scheduleScrollToActive() {
        if (this._destroyed || !this._viewport) return;
        this._scheduleTimeout(SCROLL_SCHEDULE_MS, () => this._scrollToActive());
    }

    _scrollToActive() {
        if (!this._viewport || !this._container || !this._clip || this._destroyed) return;

        let active = global.workspace_manager.get_active_workspace_index();
        let children = this._container.get_children();
        if (active < 0 || active >= children.length) return;

        let innerW = this._clip.get_width();
        if (innerW <= 0) return;

        let btn = children[active];
        let alloc = btn.get_allocation_box();
        let btnX = alloc.x1;
        let btnW = alloc.x2 - alloc.x1;

        if (btnW <= 0 || (btnX === 0 && active > 0)) {
            this._scheduleTimeout(SCROLL_RETRY_MS, () => this._scrollToActive());
            return;
        }

        let contentW = this._realContentWidth();
        if (contentW <= innerW) {
            this._setScrollOffset(0);
            return;
        }

        let peek = Math.min(30, Math.floor(innerW / 8));
        let viewStart = this._scrollOffset;
        let viewEnd = viewStart + innerW;
        let maxOffset = Math.max(0, contentW - innerW);

        let target = null;
        if (btnX < viewStart + peek) {
            target = Math.max(0, btnX - peek);
        } else if (btnX + btnW > viewEnd - peek) {
            target = btnX + btnW - innerW + peek;
        }

        if (target === null) return;

        target = Math.max(0, Math.min(maxOffset, target));
        this._scrollOffset = target;
        this._container.set_x(-this._scrollOffset);
        this._updateOverlays();
    }

    _updateOverlays() {
        if (!this._viewport || !this._container || !this._clip || this._destroyed) return;
        if (!this._arrowLeft || !this._arrowRight) return;

        let viewW = this._viewport.get_width();
        let viewH = this._viewport.get_height();
        if (viewW <= 0 || viewH <= 0) return;

        let contentW = this._realContentWidth();

        // Overflow when the content is wider than the viewport.
        // Only then do we reserve the arrow strips; otherwise layout mirrors v1.
        let availForContent = Math.max(0, viewW);
        let hasOverflow = contentW > availForContent + OVERFLOW_TOLERANCE;

        let clipX, clipW;
        if (hasOverflow) {
            clipX = ARROW_STRIP_WIDTH;
            clipW = Math.max(0, viewW - clipX - ARROW_STRIP_WIDTH);
        } else {
            clipX = 0;
            clipW = Math.min(contentW > 0 ? contentW : availForContent, availForContent);
        }

        this._clip.set_position(clipX, 0);
        this._clip.set_width(clipW);
        this._clip.set_height(viewH);

        let [, containerH] = this._container.get_preferred_height(-1);
        let effectiveH = Math.max(viewH, containerH);
        this._container.set_height(effectiveH);
        this._container.set_y(Math.floor((viewH - effectiveH) / 2));

        let [, arrowH] = this._arrowLeft.get_preferred_height(-1);
        let yCenter = Math.max(0, Math.floor((viewH - arrowH) / 2));
        this._arrowLeft.set_position(0, yCenter);
        this._arrowRight.set_position(Math.max(0, viewW - ARROW_STRIP_WIDTH), yCenter);

        let maxOffset = Math.max(0, contentW - clipW);
        if (!hasOverflow) {
            this._scrollOffset = 0;
        } else if (this._scrollOffset > maxOffset) {
            this._scrollOffset = maxOffset;
        }
        this._container.set_x(-this._scrollOffset);

        this._arrowLeft.visible = hasOverflow && this._scrollOffset > OVERFLOW_TOLERANCE;
        this._arrowRight.visible = hasOverflow && (this._scrollOffset + clipW < contentW - OVERFLOW_TOLERANCE);
        this._magnifier?.refresh();
    }

    // ===================== INITIAL POPULATION =====================

    _initialPopulation() {
        let nWs = global.workspace_manager.get_n_workspaces();
        for (let wsIndex = 0; wsIndex < nWs; wsIndex++) {
            this._winIdsRepr.push([]);
            this._addWorkspaceButton(wsIndex);

            let windows = this._getWorkspaceWindows(wsIndex);
            for (let windowObj of windows) {
                let winId = windowObj.get_id();
                this._winIdsRepr[wsIndex].push(winId);
                this._addWindowIcon("r", windowObj, wsIndex);
                this._connectStickyListener(windowObj);
            }

            this._addWindowAddedEvent(wsIndex);
        }

        // Mirror genuinely-sticky windows. Deferred: is_on_all_workspaces()
        // reads true transiently while mutter reassigns a window's workspace
        // (overview drag, gap-drop rebuild). Reconciling on a later tick reads
        // the SETTLED state, so transient stickiness never leaves stuck mirrors.
        this._scheduleStickyReconcile();

        this._updateActiveWorkspace();
    }

    // ===================== WORKSPACE BUTTONS =====================

    _connectClick(actor, callback) {
        if (Clutter.ClickGesture) {
            // GNOME 51's DndStartGesture owns the pointer/touch sequence, so
            // legacy button-release-event handlers no longer receive clicks.
            // A click gesture competes with dragging and handles taps as well.
            let gesture = new Clutter.ClickGesture({ required_button: 0 });
            gesture.connect('recognize', () => {
                let coords = gesture.get_coords_abs?.() ?? gesture.get_coords?.();
                let x = coords?.x ?? 0;
                let y = coords?.y ?? 0;
                callback(actor, gesture.get_button(), x, y);
            });
            actor.add_action(gesture);

            if (Clutter.LongPressGesture) {
                let longPress = new Clutter.LongPressGesture({
                    long_press_duration_ms: TOUCH_LONG_PRESS_DURATION_MS,
                });
                longPress.connect('recognize', () => {
                    let coords = longPress.get_coords_abs?.() ?? longPress.get_coords?.();
                    let x = coords?.x ?? 0;
                    let y = coords?.y ?? 0;
                    callback(actor, Clutter.BUTTON_SECONDARY, x, y);
                });
                if (actor._draggable?.startGesture)
                    longPress.can_not_cancel(actor._draggable.startGesture);
                actor.add_action(longPress);
            }
        } else {
            actor.connect('button-release-event', (_actor, event) => {
                let [x, y] = event.get_coords();
                return callback(actor, event.get_button(), x, y);
            });
        }
    }

    _addWorkspaceButton(wsIndex) {
        // x/y_expand EXPLICITLY false: Clutter computes needs_expand from the
        // descendants unless the actor sets it explicitly, and the count badge
        // inside a combined icon must be expanding (corner alignment in a
        // BinLayout only applies to the extra space expand grants). Without
        // this pin, that expand would propagate up to the cell and make it
        // absorb the container's spare width, stretching the pill and pushing
        // the last cells out of the clip.
        let btnWrapper = new St.BoxLayout({
            style_class: "wsb-ws-btn-wrapper",
            reactive: true,
            x_expand: false,
            y_expand: false,
        });
        btnWrapper.wsIndex = wsIndex;

        let wsNumWrapper = new St.BoxLayout({ style_class: "wsb-ws-num-wrapper" });
        let wsNum = new St.Label({
            text: `${wsIndex + 1}`,
            style_class: "wsb-ws-num-label-elem",
            y_align: Clutter.ActorAlign.CENTER,
        });
        wsNumWrapper.add_child(wsNum);
        btnWrapper._wsbNumLabel = wsNum; // direct ref (avoids a deep get_children() chain)

        let iconsWrapper = new St.BoxLayout({ style_class: "wsb-icons-wrapper" });

        // The rim is a structural parent of the two pill segments: every
        // animation that moves the button (FLIP, drag, squeeze) carries it for
        // free. Its transparent 1px border reserves the space; the shadows
        // variants only color it, so toggling never reflows the bar.
        let pillRim = new St.BoxLayout({ style_class: "wsb-pill-rim" });
        pillRim.add_child(wsNumWrapper);
        pillRim.add_child(iconsWrapper);
        btnWrapper.add_child(pillRim);
        btnWrapper._wsbNumWrapper = wsNumWrapper;
        wsNumWrapper._wsbWorkspaceButton = btnWrapper;
        btnWrapper._wsbIconsWrapper = iconsWrapper;

        // DnD: workspace button is both a drop target and a drag source
        let self = this;
        btnWrapper._delegate = {
            handleDragOver(source, actor, x, y) {
                if (!self._container) return DND.DragMotionResult.CONTINUE;
                // DnD only calls handleDragOver on the target UNDER the cursor — it
                // never signals the one you just left. So clear the highlight from
                // ALL cells first, then mark the current one; otherwise every cell
                // dragged across stays highlighted.
                if (source.windowObj) {
                    self._clearDragHover();
                    if (self._insertionIndicator) return DND.DragMotionResult.CONTINUE;
                    btnWrapper.add_style_class_name("wsb-ws-btn-drag-hover");
                    return DND.DragMotionResult.MOVE_DROP;
                }
                if (source.wsButton && source.actor !== btnWrapper) {
                    self._clearDragHover();
                    btnWrapper.add_style_class_name("wsb-ws-btn-drag-hover");
                    return DND.DragMotionResult.MOVE_DROP;
                }
                return DND.DragMotionResult.CONTINUE;
            },
            acceptDrop(source) {
                btnWrapper.remove_style_class_name("wsb-ws-btn-drag-hover");
                if (source.windowObj) {
                    // A combined icon carries its whole group (captured at
                    // drag-begin); a plain icon or a popup row carries one window.
                    let windows = source.wsbGroupWindows?.length
                        ? source.wsbGroupWindows : [source.windowObj];
                    let targetWorkspace = global.workspace_manager.get_workspace_by_index(btnWrapper.wsIndex);
                    if (!targetWorkspace) return false;
                    for (let w of windows)
                        w.change_workspace(targetWorkspace);
                    targetWorkspace.activate(global.get_current_time());
                    self._scheduleWorkspaceCleanup();
                    return true;
                }
                if (source.wsButton) {
                    let srcIdx = source.actor.wsIndex;
                    let tgtIdx = btnWrapper.wsIndex;
                    if (srcIdx === tgtIdx) return false;
                    // FLIP: capture each cell's current screen X so the deferred
                    // rebuild can slide the cells from old → new positions.
                    let oldXs = self._container.get_children().map(
                        c => c.get_transformed_position()[0]);
                    self._reorderFlip = { oldXs, src: srcIdx, tgt: tgtIdx };
                    let wsObj = global.workspace_manager.get_workspace_by_index(srcIdx);
                    global.workspace_manager.reorder_workspace(wsObj, tgtIdx);
                    global.workspace_manager.get_workspace_by_index(tgtIdx).activate(global.get_current_time());
                    self._scheduleWorkspaceCleanup();
                    // Schedule the rebuild ourselves (idempotent): if the reorder is a
                    // no-op it emits no 'workspaces-reordered', which would otherwise
                    // leave _reorderFlip stuck non-null and disable the ws add/remove
                    // handlers. Mirrors the gap-drop path.
                    self._scheduleRebuild();
                    return true;
                }
                return false;
            },
            actor: btnWrapper,
            wsButton: true,
            getDragActor() {
                return new St.Label({
                    text: `${btnWrapper.wsIndex + 1}`,
                    style_class: 'wsb-ws-num-label-elem',
                    style: 'background-color: rgba(255,255,255,0.2); padding: 4px 10px; border-radius: 6px;',
                });
            },
            getDragActorSource() {
                return btnWrapper;
            },
        };

        let draggable = DND.makeDraggable(btnWrapper, {
            timeoutThreshold: TOUCH_DND_TIMEOUT_THRESHOLD,
        });
        btnWrapper._draggable = draggable;
        draggable.connect('drag-begin', () => {
            self._magnifier?.beginDrag();
            btnWrapper.opacity = 128;
            btnWrapper._isDragging = true;
        });
        let onDragReset = () => {
            if (!self._container) return;
            btnWrapper.opacity = 255;
            btnWrapper._isDragging = false;
            self._magnifier?.endDrag();
            self._clearDragHover();
        };
        draggable.connect('drag-end', onDragReset);
        draggable.connect('drag-cancelled', onDragReset);

        this._container.insert_child_at_index(btnWrapper, wsIndex);
        this._updateWsNumbers();

        // Click handler
        this._connectClick(btnWrapper, (actor, button, x, y) => {
            if (actor._isDragging) return Clutter.EVENT_PROPAGATE;

            // If an icon inside this cell handled this click/tap within 300ms, ignore
            if (self._lastHandledIconTime &&
                GLib.get_monotonic_time() - self._lastHandledIconTime < 300000) {
                return Clutter.EVENT_STOP;
            }

            // Detect if an icon was clicked (needed by both middle- and primary-click and right-click)
            let clickedIconWrapper = null;
            let stage = actor.get_stage();
            if (stage && x !== undefined && y !== undefined) {
                let elemClicked = stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
                let curElem = elemClicked;
                while (curElem && curElem !== actor) {
                    if (curElem.has_style_class_name && curElem.has_style_class_name('wsb-single-icon-wrapper')) {
                        clickedIconWrapper = curElem;
                        break;
                    }
                    curElem = curElem.get_parent();
                }
                // Fallback geometry check across visible icons
                if (!clickedIconWrapper && actor._wsbIconsWrapper) {
                    for (let icon of actor._wsbIconsWrapper.get_children()) {
                        if (icon.visible && self._actorContainsPoint(icon, x, y)) {
                            clickedIconWrapper = icon;
                            break;
                        }
                    }
                }
            }

            // If an icon was clicked, delegate directly to _handleIconClick
            if (clickedIconWrapper) {
                self._handleIconClick(clickedIconWrapper, button, x, y);
                return Clutter.EVENT_STOP;
            }

            return self._handleWorkspaceClick(actor, button);
        });

        return btnWrapper;
    }

    _updateWsNumbers() {
        if (!this._container) return;
        let children = this._container.get_children();
        for (let i = 0; i < children.length; i++) {
            children[i].wsIndex = i;
            children[i]._wsbNumLabel.text = `${i + 1}`;
            if (i === children.length - 1) {
                children[i].add_style_class_name('wsb-last-child');
            } else {
                children[i].remove_style_class_name('wsb-last-child');
            }
        }
    }

    _updateActiveWorkspace() {
        if (!this._container) return;
        let activeWs = global.workspace_manager.get_active_workspace_index();

        for (let btn of this._container.get_children()) {
            let numWrapper = btn._wsbNumWrapper;
            let iconsWrapper = btn._wsbIconsWrapper;
            if (btn.wsIndex === activeWs) {
                numWrapper.add_style_class_name("wsb-ws-num-wrapper-active");
                iconsWrapper.add_style_class_name("wsb-icons-wrapper-active");
            } else {
                numWrapper.remove_style_class_name("wsb-ws-num-wrapper-active");
                iconsWrapper.remove_style_class_name("wsb-icons-wrapper-active");
            }
        }

        this._scheduleSync();
        this._scheduleScrollToActive();
    }

    // ===================== WINDOW ICONS =====================

    _addWindowIcon(loc, windowObj, wsIndex) {
        let iconElem = this._createWindowIcon(windowObj);
        let iconsWrapper = this._container.get_children()[wsIndex]._wsbIconsWrapper;
        if (loc === "l") {
            iconsWrapper.insert_child_at_index(iconElem, 0);
        } else {
            // Append primary BEFORE any sticky mirrors so primary indices keep
            // matching _winIdsRepr[ws]
            let firstMirrorIdx = this._findFirstMirrorIndex(iconsWrapper);
            if (firstMirrorIdx < 0) iconsWrapper.add_child(iconElem);
            else iconsWrapper.insert_child_at_index(iconElem, firstMirrorIdx);
        }
        this._regroupWorkspaceButton(this._container.get_children()[wsIndex]);
        this._scheduleSync();
        return iconElem;
    }

    _moveWindowIcon(oldWsIndex, oldWinIndex, newWsIndex, newWinIndex) {
        let oldParent = this._container.get_children()[oldWsIndex]._wsbIconsWrapper;
        let elem = oldParent.get_children()[oldWinIndex];
        oldParent.remove_child(elem);
        let newParent = this._container.get_children()[newWsIndex]._wsbIconsWrapper;
        newParent.insert_child_at_index(elem, newWinIndex);
        // Smooth arrival: the icon pops in at its new workspace.
        this._animateIconIn(elem);
        // Both cells' groups changed (the icon may join a group on arrival or
        // dissolve one on departure).
        this._regroupAllButtons();
    }

    // ----- reusable transform-only icon/cell transitions -----

    // Fade + spring pop-in an actor from a starting scale to full size.
    _popIn(actor, startScale) {
        actor.set_pivot_point(0.5, 0.5);
        actor.opacity = 0;
        actor.set_scale(startScale, startScale);
        actor.ease({
            opacity: 255,
            duration: 300 * ANIM_SLOWMO,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        actor.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 360 * ANIM_SLOWMO,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        // Watchdog: an ease interrupted by a competing transition (or a stalled
        // frame clock) never fires and would leave the actor stuck at opacity 0,
        // invisible but still taking space. Snap to the final state; a no-op when
        // the ease finished, skipped when the actor is meanwhile fading OUT.
        // The actor may be destroyed before the watchdog fires (a rebuild or a
        // workspace removal in the meantime); touching a disposed GObject logs a
        // critical even inside try/catch, so track destruction explicitly.
        let destroyed = false;
        let destroyId = actor.connect('destroy', () => { destroyed = true; });
        this._scheduleTimeout(360 * ANIM_SLOWMO + 120, () => {
            if (destroyed) return;
            try {
                actor.disconnect(destroyId);
                if (!actor.get_parent() || actor._wsbDying || actor._wsbClosing) return;
                actor.opacity = 255;
                actor.set_scale(1, 1);
            } catch (_e) {}
        });
    }

    _animateIconIn(icon) {
        if (!icon || !this._ext.getEnableAnimations()) return;
        icon.remove_all_transitions();
        this._popIn(icon, 0.5);
    }

    // Fade a closing window's icon out IN PLACE — no reparent, no scale — so it
    // keeps its exact size and position while disappearing, and the cell keeps its
    // height (the icon stays in the wrapper until the fade ends). The model entry
    // and the actor are removed only on completion (the winId is re-found in case
    // indices shifted), so _winIdsRepr stays aligned with the wrapper throughout.
    _animateIconOut(icon, winId) {
        if (!icon) return;
        // Take the icon out of its group right away: the badge count drops (or a
        // hidden member is promoted to leader) while the icon fades out.
        icon._wsbClosing = true;
        this._regroupAllButtons();
        if (!this._ext.getEnableAnimations()) { this._finalizeClosedIcon(icon, winId); return; }
        icon.ease({
            opacity: 0,
            duration: 260 * ANIM_SLOWMO,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._finalizeClosedIcon(icon, winId),
        });
    }

    _finalizeClosedIcon(icon, winId) {
        if (this._winIdsRepr) {
            for (let w = 0; w < this._winIdsRepr.length; w++) {
                let idx = this._winIdsRepr[w].indexOf(winId);
                if (idx >= 0) { this._winIdsRepr[w].splice(idx, 1); break; }
            }
        }
        // The icon may already be gone if a rebuild destroyed the bar mid-fade.
        try {
            let p = icon.get_parent();
            if (p) p.remove_child(icon);
            icon.destroy();
        } catch (_e) {}
        this._scheduleSync();
    }

    // A freshly-added (usually trailing) workspace cell fades + gently pops in.
    _animateWorkspaceIn(btn) {
        if (!btn || !this._ext.getEnableAnimations()) return;
        this._popIn(btn, 0.7);
    }

    // A removed workspace cell fades out IN PLACE (opacity only — no reparent, no
    // scale) so it keeps its exact size + position while disappearing. The button
    // stays in the container and its _winIdsRepr entry is kept until the fade ends,
    // so the model stays aligned. To avoid the old pile-up under rapid dynamic-
    // workspace churn, any still-fading cell is finalised before a new collapse
    // starts (at most one fades at a time).
    _animateWorkspaceCollapse(wsIndex) {
        if (!this._container) return;
        this._finalizeAllDyingCells();
        let button = this._container.get_children()[wsIndex];
        if (!button) return;
        button._wsbDying = true;
        if (!this._ext.getEnableAnimations()) { this._finalizeDyingCell(button); return; }
        button.ease({
            opacity: 0,
            duration: 280 * ANIM_SLOWMO,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._finalizeDyingCell(button),
        });
        // Watchdog: if the fade is interrupted (a competing ease on the same
        // cell replaces the transition and its onComplete never fires), the
        // dying cell would sit in the bar forever as a ghost pill. Finalize is
        // idempotent, so this is a no-op when the fade completed normally.
        this._scheduleTimeout(280 * ANIM_SLOWMO + 120, () => this._finalizeDyingCell(button));
    }

    // Remove a finished/preempted dying cell: drop its actor + its _winIdsRepr entry
    // (at the button's real current index, in case ws were added/removed meanwhile),
    // then renumber + refresh the active highlight.
    _finalizeDyingCell(button) {
        if (!button || !button._wsbDying) return;
        button._wsbDying = false;
        // The button may already be gone if a rebuild destroyed the bar mid-fade.
        try {
            if (this._container) {
                let idx = this._container.get_children().indexOf(button);
                if (idx >= 0) {
                    this._container.remove_child(button);
                    if (this._winIdsRepr && idx < this._winIdsRepr.length)
                        this._winIdsRepr.splice(idx, 1);
                }
            }
            button.destroy();
        } catch (_e) {}
        if (this._container) {
            this._updateWsNumbers();
            this._updateActiveWorkspace();
            this._scheduleSync();
        }
    }

    _finalizeAllDyingCells() {
        if (!this._container) return;
        for (let c of this._container.get_children().slice()) {
            if (c._wsbDying) this._finalizeDyingCell(c);
        }
    }

    _createWindowIcon(windowObj) {
        let iconSize = this._ext.getPreset().iconSize;
        // BinLayout (not BoxLayout): the count badge of a combined icon overlays
        // the icon's top-right corner instead of sitting next to it.
        let wrapper = new St.Widget({
            style_class: "wsb-single-icon-wrapper",
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
        });
        wrapper.windowId = windowObj.get_id();
        wrapper.windowObj = windowObj;

        let appObj = Shell.WindowTracker.get_default().get_window_app(windowObj);
        let iconTex = appObj
            ? appObj.create_icon_texture(iconSize)
            : new St.Icon({ icon_name: 'image-missing-symbolic', icon_size: iconSize });
        iconTex.set_pivot_point(0.5, 0.5);
        wrapper.add_child(iconTex);
        wrapper._iconTex = iconTex;
        this._applyIconEffects(wrapper, false);

        // DnD: make icon draggable
        let self = this;
        wrapper._delegate = {
            windowObj: windowObj,
            actor: wrapper,
            getDragActor() {
                return self._makeDragIcon(windowObj, iconSize,
                    self._getGroupWindows(wrapper).length);
            },
            getDragActorSource() {
                return wrapper;
            },
        };

        let draggable = DND.makeDraggable(wrapper, {
            timeoutThreshold: TOUCH_DND_TIMEOUT_THRESHOLD,
        });
        wrapper._draggable = draggable;
        draggable.connect('drag-begin', () => {
            if (!self._container) return;
            self._magnifier?.beginDrag();
            wrapper._isDragging = true;
            wrapper.opacity = 128;
            self._closeWindowPopup();
            // Freeze the group membership NOW: what you grabbed is what goes.
            let group = self._getGroupWindows(wrapper);
            wrapper._delegate.wsbGroupWindows = group;
            self._registerGapDragMonitor(group);
        });
        let onDragReset = () => {
            if (!self._container) return;
            wrapper._isDragging = false;
            self._magnifier?.endDrag();
            wrapper.opacity = 255;
            wrapper._delegate.wsbGroupWindows = null;
            self._unregisterGapDragMonitor();
            self._clearDragHover();
        };
        draggable.connect('drag-end', onDragReset);
        draggable.connect('drag-cancelled', onDragReset);

        this._connectClick(wrapper, (actor, button, x, y) => {
            if (actor._isDragging) return Clutter.EVENT_PROPAGATE;
            self._handleIconClick(actor, button, x, y);
            return Clutter.EVENT_STOP;
        });

        return wrapper;
    }

    _handleIconClick(iconWrapper, button, x, y) {
        if (!iconWrapper || iconWrapper._isDragging) return;
        this._lastHandledIconTime = GLib.get_monotonic_time();
        const input = this._clickInput(button);
        if (input) this._executeGestureAction(this._gestureTarget(iconWrapper),
            this._gestureSettings.get_string(`gesture-app-${input}`));
    }

    // Drag actor for one or several windows of the same app: the app icon,
    // plus the same count badge the combined icon wears when it is a group.
    _makeDragIcon(windowObj, iconSize, count) {
        let appObj = Shell.WindowTracker.get_default().get_window_app(windowObj);
        let iconTex = appObj
            ? appObj.create_icon_texture(iconSize)
            : new St.Icon({ icon_name: 'image-missing-symbolic', icon_size: iconSize });
        if (count < 2) return iconTex;

        let holder = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        holder.add_child(iconTex);
        holder.add_child(new St.Label({
            text: `${count}`,
            style_class: 'wsb-count-badge',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        }));
        return holder;
    }

    _regenerateIcons() {
        if (!this._container) return;
        let allWindows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
        let windowsMap = {};
        for (let w of allWindows) windowsMap[w.get_id()] = w;

        for (let btn of this._container.get_children()) {
            let iconsWrapper = btn._wsbIconsWrapper;
            let icons = iconsWrapper.get_children();
            for (let i = 0; i < icons.length; i++) {
                let winId = icons[i].windowId;
                if (windowsMap[winId]) {
                    let wasMirror = icons[i]._isStickyMirror;
                    let newIcon = this._createWindowIcon(windowsMap[winId]);
                    if (wasMirror) newIcon._isStickyMirror = true;
                    iconsWrapper.replace_child(icons[i], newIcon);
                }
            }
        }
        this._regroupAllButtons();
        this._scheduleSync();
    }

    // ===================== WINDOW TRACKING =====================

    _getWorkspaceWindows(wsIndex) {
        let wsObj = global.workspace_manager.get_workspace_by_index(wsIndex);
        let windows = global.display.get_tab_list(Meta.TabList.NORMAL, wsObj);
        return windows.filter(w => {
            if (w.skip_taskbar) return false;
            // get_tab_list(NORMAL, wsObj) also returns on-all-workspaces windows
            // AND windows mid-reassignment (transient null workspace) for EVERY
            // workspace. Keep a window only on the workspace it actually lives on,
            // otherwise it gets a duplicate PRIMARY icon on every workspace button
            // (the real bug, triggered when another extension — e.g. Quake Terminal
            // — perturbs workspace-move timing). For a sticky window get_workspace()
            // resolves to the active workspace (its anchor); mirror icons for the
            // other workspaces are added separately via _addStickyMirrors.
            return w.get_workspace()?.index() === wsIndex;
        });
    }

    _getWinIdsMeta() {
        let meta = {};
        for (let wsIndex = 0; wsIndex < this._winIdsRepr.length; wsIndex++) {
            for (let winId of this._winIdsRepr[wsIndex]) {
                meta[winId] = { wsIndex };
            }
        }
        return meta;
    }

    // ===================== STICKY WINDOW MIRRORS =====================
    // A sticky ("Always on Visible Workspace") window appears once in _winIdsRepr
    // on its anchor workspace. To make its icon appear in every other workspace
    // button, we add tagged "mirror" icons (_isStickyMirror = true) at the end
    // of the other iconsWrappers. Primary icons keep [0, _winIdsRepr[ws].length)
    // child indices; mirrors always sit at the end so primary indexing stays valid.

    _findPrimaryWsForWindow(winId) {
        for (let i = 0; i < this._winIdsRepr.length; i++) {
            if (this._winIdsRepr[i].includes(winId)) return i;
        }
        return -1;
    }

    _findFirstMirrorIndex(iconsWrapper) {
        let children = iconsWrapper.get_children();
        for (let i = 0; i < children.length; i++) {
            if (children[i]._isStickyMirror) return i;
        }
        return -1;
    }

    _findMirrorIcon(winId, wsIndex) {
        let btn = this._container.get_children()[wsIndex];
        if (!btn) return null;
        let iconsWrapper = btn._wsbIconsWrapper;
        if (!iconsWrapper) return null;
        for (let icon of iconsWrapper.get_children()) {
            if (icon.windowId === winId && icon._isStickyMirror) return icon;
        }
        return null;
    }

    _connectStickyListener(windowObj) {
        let winId = windowObj.get_id();
        if (this._stickyListenerIds.has(winId)) return;
        let signalId = windowObj.connect('notify::on-all-workspaces', () => {
            this._onWindowStickyChanged(windowObj);
        });
        this._stickyListenerIds.set(winId, { windowObj, signalId });
    }

    _disconnectStickyListener(winId) {
        let entry = this._stickyListenerIds.get(winId);
        if (!entry) return;
        try { entry.windowObj.disconnect(entry.signalId); } catch (_e) {}
        this._stickyListenerIds.delete(winId);
    }

    _onWindowStickyChanged(windowObj) {
        if (!this._container) return;
        let winId = windowObj.get_id();
        if (windowObj.is_on_all_workspaces()) {
            this._addStickyMirrors(windowObj);
        } else {
            this._removeStickyMirrors(winId);
        }
    }

    _addStickyMirrors(windowObj) {
        if (!this._container) return;
        let winId = windowObj.get_id();
        let primaryWs = this._findPrimaryWsForWindow(winId);
        if (primaryWs < 0) return;
        let nWs = this._container.get_children().length;
        for (let wsIndex = 0; wsIndex < nWs; wsIndex++) {
            if (wsIndex === primaryWs) continue;
            if (this._findMirrorIcon(winId, wsIndex)) continue;
            let iconElem = this._createWindowIcon(windowObj);
            iconElem._isStickyMirror = true;
            let iconsWrapper = this._container.get_children()[wsIndex]._wsbIconsWrapper;
            iconsWrapper.add_child(iconElem); // append at end keeps primary indices valid
        }
        this._scheduleSync();
    }

    _removeStickyMirrors(winId) {
        if (!this._container) return;
        for (let btn of this._container.get_children()) {
            let iconsWrapper = btn._wsbIconsWrapper;
            if (!iconsWrapper) continue;
            for (let icon of iconsWrapper.get_children()) {
                if (icon.windowId === winId && icon._isStickyMirror) {
                    iconsWrapper.remove_child(icon);
                }
            }
        }
        this._scheduleSync();
    }

    _hasStickyMirror(winId) {
        if (!this._container) return false;
        for (let btn of this._container.get_children()) {
            let iconsWrapper = btn._wsbIconsWrapper;
            if (!iconsWrapper) continue;
            for (let icon of iconsWrapper.get_children()) {
                if (icon.windowId === winId && icon._isStickyMirror) return true;
            }
        }
        return false;
    }

    // Reconcile every tracked window's mirror icons against its REAL, settled
    // is_on_all_workspaces() state. is_on_all_workspaces() briefly returns true
    // while mutter moves a window between workspaces (overview window-drag,
    // gap-drop reorder rebuild, fresh-window placement) without ever emitting a
    // notify::on-all-workspaces to correct it — which used to leave a window's
    // icon mirrored across every workspace button forever. Running this on a
    // settled tick adds mirrors for genuinely-sticky windows and removes the
    // spurious ones from the transient reads.
    _scheduleStickyReconcile() {
        if (this._stickyReconcileId || !this._glibTimeoutIds) return;
        let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ICON_TIMEOUT, () => {
            this._glibTimeoutIds?.delete(id);
            this._stickyReconcileId = null;
            this._reconcileStickyMirrors();
            return GLib.SOURCE_REMOVE;
        });
        this._stickyReconcileId = id;
        this._glibTimeoutIds.add(id);
    }

    _scheduleRebuild() {
        if (this._rebuildId || !this._glibTimeoutIds) return;
        // Append + reorder + activate is one synchronous transaction. Rebuild
        // from its settled state before the next paint, not 200 ms later:
        // otherwise the active highlight and icons refer to the old indices
        // while a transient appended cell is already visible at the far end.
        let id = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._rebuildId = null;
            // Always clear the gap/reorder flags so a failure can never leave them
            // stuck (which would hide every future workspace cell).
            let pendingGapAnim = this._pendingGapAnim;
            let reorderFlip = this._reorderFlip;
            this._pendingGapAnim = null;
            this._reorderFlip = null;
            this._gapDropInProgress = false;
            try {
                this.destroy(false);
                this._setup();
                if (pendingGapAnim != null) this._playGapDropAnimation(pendingGapAnim);
                else if (reorderFlip != null) this._playReorderFlip(reorderFlip);
            } catch (e) {
                console.error('[Workspace Bar] rebuild failed', e);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._rebuildId = id;
    }

    // FLIP slide for a workspace reorder: the rebuild already put every cell at its
    // new position; we translate each cell back to where it WAS (captured before the
    // reorder) and ease that offset to 0, so the cells visibly slide into the new
    // order instead of the bar blinking out and back. Transform-only (translation_x).
    _playReorderFlip(flip, attempt = 0) {
        if (!this._container || this._destroyed || !flip) return;
        if (!this._ext.getEnableAnimations()) return; // rebuild already placed cells
        let children = this._container.get_children();
        if (children.length === 0) return;

        // Wait for the rebuilt cells to be allocated so newX is real.
        let firstAlloc = children[0].get_allocation_box();
        if (firstAlloc.x2 - firstAlloc.x1 <= 0 && attempt < 8) {
            this._scheduleTimeout(40, () => this._playReorderFlip(flip, attempt + 1));
            return;
        }

        let { oldXs, src, tgt } = flip;
        // If workspace cleanup changed the cell count between capture and rebuild,
        // the old→new index remap would be off — fall back to the rebuild's already
        // correct instant placement instead of a wrong-direction slide.
        if (children.length !== oldXs.length) return;
        let dur = 360 * ANIM_SLOWMO;
        for (let j = 0; j < children.length; j++) {
            // Which old index holds the workspace now sitting at new index j?
            let oldIndex;
            if (j === tgt) oldIndex = src;
            else if (src < tgt && j >= src && j < tgt) oldIndex = j + 1;
            else if (src > tgt && j > tgt && j <= src) oldIndex = j - 1;
            else oldIndex = j;

            let oldX = oldXs[oldIndex];
            if (oldX == null) continue;
            let newX = children[j].get_transformed_position()[0];
            let delta = oldX - newX;
            if (Math.abs(delta) < 1) continue;

            children[j].translation_x = delta;
            children[j].ease({
                translation_x: 0,
                duration: dur,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    // Apple-style reveal of a gap-dropped app — transform-only so it NEVER fights
    // the layout/overflow machinery (no width pinning, no freezing → no squeeze,
    // clipping, flattening or leftover gaps). The deferred rebuild already placed
    // every cell at its final geometry. We just:
    //   • snap the right-neighbours back to their PRE-INSERT visual spot (translated
    //     left by the new cell's slot width) and glide them to 0 → they slide aside
    //     to "make room", with no initial jump;
    //   • fade the new cell in as it's revealed; spring-pop its icon for delight.
    // translation_x / scale / opacity are post-layout transforms, so allocations,
    // height, clip and sync stay exactly as the normal code computed them.
    _playGapDropAnimation(winId) {
        if (!this._container || this._destroyed) return;
        if (!this._ext.getEnableAnimations()) return; // rebuild already shows final state

        let children = this._container.get_children();
        let newIndex = -1, targetIcon = null;
        for (let i = 0; i < children.length; i++) {
            let iconsWrapper = children[i]._wsbIconsWrapper;
            if (!iconsWrapper) continue;
            for (let icon of iconsWrapper.get_children()) {
                if (icon.windowId === winId && !icon._isStickyMirror) {
                    newIndex = i;
                    targetIcon = icon;
                    break;
                }
            }
            if (newIndex >= 0) break;
        }
        if (newIndex < 0) return;

        let newCell = children[newIndex];

        // With combined icons the dropped window's own icon may be a hidden
        // group member — pop the cell's visible leader instead.
        if (targetIcon && !targetIcon.visible) {
            targetIcon = newCell._wsbIconsWrapper.get_children()
                .find(c => c.visible && !c._isStickyMirror) ?? null;
        }

        // Glide distance ≈ the new cell's slot (preferred width + button spacing).
        // Use PREFERRED width, not allocation, so this whole setup runs synchronously
        // in the rebuild tick — the initial state (cell hidden, neighbours shifted to
        // their pre-insert spot) is in place before the first paint, so there is no
        // flash of the finished layout.
        let preset = this._ext.getPreset();
        let [, cellW] = newCell.get_preferred_width(-1);
        if (cellW <= 0) cellW = preset.iconSize + preset.numSpacing * 2 + 20;
        let offset = cellW + (preset.btnSpacing || 6);

        let dur = 380 * ANIM_SLOWMO;

        // Right-neighbours: start at their old visual position, glide into place.
        for (let i = newIndex + 1; i < children.length; i++) {
            let sib = children[i];
            sib.translation_x = -offset;
            sib.ease({
                translation_x: 0,
                duration: dur,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        // New cell: fade in as it gets revealed.
        newCell.opacity = 0;
        newCell.ease({
            opacity: 255,
            duration: dur,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Icon: gentle spring-pop (uniform scale → no distortion).
        if (targetIcon) {
            targetIcon.set_pivot_point(0.5, 0.5);
            targetIcon.set_scale(0.55, 0.55);
            targetIcon.ease({
                scale_x: 1,
                scale_y: 1,
                delay: 80 * ANIM_SLOWMO,
                duration: dur,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }

        // Clear stray transforms once done (the eases land on these values anyway;
        // this guards against an interrupting re-layout leaving an offset behind).
        let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, dur + 120 * ANIM_SLOWMO + 30, () => {
            this._glibTimeoutIds?.delete(id);
            if (this._destroyed || !this._container) return GLib.SOURCE_REMOVE;
            for (let c of this._container.get_children()) c.translation_x = 0;
            if (newCell.get_parent()) newCell.opacity = 255;
            if (targetIcon && targetIcon.get_parent()) targetIcon.set_scale(1, 1);
            return GLib.SOURCE_REMOVE;
        });
        this._glibTimeoutIds.add(id);
    }

    _reconcileStickyMirrors() {
        if (!this._container || !this._stickyListenerIds) return;
        for (let entry of this._stickyListenerIds.values()) {
            let windowObj = entry.windowObj;
            let winId, sticky;
            try {
                winId = windowObj.get_id();
                sticky = windowObj.is_on_all_workspaces();
            } catch (_e) {
                continue;
            }
            let hasMirror = this._hasStickyMirror(winId);
            if (sticky && !hasMirror) this._addStickyMirrors(windowObj);
            else if (!sticky && hasMirror) this._removeStickyMirrors(winId);
        }
    }

    // ===================== COMBINED APP ICONS =====================
    // With `combine-icons` on, several windows of the same app on the same
    // workspace are shown as ONE icon (the "leader") wearing a window-count
    // badge; the other members stay in the wrapper but hidden, so every
    // index-based invariant between _winIdsRepr and the child list holds
    // unchanged. Clicking the leader opens a popup listing the windows (click
    // to activate, drag to move one); dragging the leader moves the whole
    // group. Group membership is recomputed from the live wrapper on every
    // use, never cached across changes — except _wsbGroupIds on the leader,
    // which is refreshed on every regroup and only feeds the focus effects.

    _appKeyForWindow(windowObj) {
        let app = Shell.WindowTracker.get_default().get_window_app(windowObj);
        return app?.get_id() ?? windowObj.get_wm_class() ?? `win-${windowObj.get_id()}`;
    }

    // The windows this icon stands for right now: itself alone when combining
    // is off (or for a sticky mirror), otherwise every primary window of the
    // same app in the same workspace cell, in child order (leader first).
    _getGroupWindows(wrapper) {
        let windowObj = wrapper.windowObj;
        if (!windowObj) return [];
        if (!this._ext.getCombineIcons() || wrapper._isStickyMirror)
            return [windowObj];
        let iconsWrapper = wrapper.get_parent();
        if (!iconsWrapper) return [windowObj];

        let key = this._appKeyForWindow(windowObj);
        let windows = [];
        for (let icon of iconsWrapper.get_children()) {
            if (icon._isStickyMirror || icon._wsbClosing || !icon.windowObj) continue;
            if (this._appKeyForWindow(icon.windowObj) === key)
                windows.push(icon.windowObj);
        }
        return windows.length ? windows : [windowObj];
    }

    _setIconBadge(wrapper, count) {
        if (count >= 2) {
            if (!wrapper._wsbBadge) {
                // Corner alignment in a BinLayout only applies to the extra
                // space that expand grants, so the badge needs x/y_expand —
                // without them it is handed the whole box and its background
                // covers the icon. The expand would normally propagate up and
                // stretch the pill; the workspace cell pins expand to false
                // explicitly (see _addWorkspaceButton), which stops it there.
                let badge = new St.Label({
                    style_class: 'wsb-count-badge',
                    x_expand: true,
                    y_expand: true,
                    x_align: Clutter.ActorAlign.END,
                    y_align: Clutter.ActorAlign.START,
                });
                wrapper.add_child(badge);
                wrapper._wsbBadge = badge;
            }
            wrapper._wsbBadge.text = `${count}`;
            wrapper._wsbBadge.show();
        } else if (wrapper._wsbBadge) {
            wrapper._wsbBadge.hide();
        }
    }

    // Recompute one cell's grouping: first non-closing primary of each app
    // leads (visible, badged when 2+), later members hide. Closing icons keep
    // whatever visibility they have while fading out and count toward nothing;
    // sticky mirrors never group. Show/hide only toggles `visible`, so child
    // order — and with it primary indexing — never changes.
    _regroupWorkspaceButton(btn) {
        let iconsWrapper = btn?._wsbIconsWrapper;
        if (!iconsWrapper) return;
        let combine = this._ext.getCombineIcons();
        let leaders = new Map(); // app key -> leader icon wrapper

        for (let icon of iconsWrapper.get_children()) {
            if (!icon.windowObj) continue;
            if (icon._wsbClosing) {
                icon._wsbGroupIds = null;
                this._setIconBadge(icon, 0);
                continue;
            }
            if (!combine || icon._isStickyMirror) {
                icon._wsbGroupIds = null;
                this._setIconBadge(icon, 0);
                icon.show();
                continue;
            }
            let key = this._appKeyForWindow(icon.windowObj);
            let leader = leaders.get(key);
            if (!leader) {
                leaders.set(key, icon);
                icon._wsbGroupIds = [icon.windowId];
                icon.show();
            } else {
                leader._wsbGroupIds.push(icon.windowId);
                icon._wsbGroupIds = null;
                this._setIconBadge(icon, 0);
                icon.hide();
            }
        }

        for (let leader of leaders.values())
            this._setIconBadge(leader, leader._wsbGroupIds.length);
    }

    _regroupAllButtons() {
        if (!this._container) return;
        for (let btn of this._container.get_children())
            this._regroupWorkspaceButton(btn);
        // A promoted leader must pick up the group's focus state immediately.
        this._refreshAllIconEffects(false);
        this._refreshWindowPopup();
        this._scheduleSync();
    }

    onCombineIconsChanged() {
        if (!this._container) return;
        this._closeWindowPopup();
        this._regroupAllButtons();
    }

    // ===================== WINDOW POPUP (combined icon) =====================
    // A plain St dropdown in uiGroup, NOT a PopupMenu: a menu's modal grab
    // would swallow the pointer events DND needs, and dragging rows out of the
    // popup onto the workspace pills is the whole point. Dismissal is handled
    // by a stage captured-event listener instead of a grab.

    _toggleWindowPopup(leaderWrapper) {
        if (this._windowPopup && this._popupLeader === leaderWrapper) {
            this._closeWindowPopup();
            return;
        }
        this._openWindowPopup(leaderWrapper);
    }

    _openWindowPopup(leaderWrapper) {
        this._closeWindowPopup();
        let group = this._getGroupWindows(leaderWrapper);
        if (group.length < 2) return;

        let popup = new St.BoxLayout({
            style_class: 'wsb-window-popup',
            reactive: true,
        });
        // St.BoxLayout:vertical was removed in GNOME 51 and its replacement,
        // St.BoxLayout:orientation, only exists from 48 on. The underlying
        // Clutter.BoxLayout has always exposed orientation, so set it there.
        popup.layout_manager.orientation = Clutter.Orientation.VERTICAL;
        // Parent the popup BEFORE filling it: adding children to an StBoxLayout
        // that is not in the stage makes St query its theme node too early.
        Main.uiGroup.add_child(popup);
        for (let windowObj of group)
            popup.add_child(this._createPopupRow(windowObj));

        this._windowPopup = popup;
        this._popupLeader = leaderWrapper;
        this._positionWindowPopup();

        // Dismiss on any press outside the popup. A press on the anchor icon is
        // left alone so its own release toggles the popup closed, instead of
        // close-here + reopen-there.
        this._popupCapturedId = global.stage.connect('captured-event', (_stage, event) => {
            let type = event.type();
            if (type === Clutter.EventType.KEY_PRESS) {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    this._closeWindowPopup();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }
            if (type !== Clutter.EventType.BUTTON_PRESS &&
                type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            if (!this._windowPopup) return Clutter.EVENT_PROPAGATE;
            let [px, py] = event.get_coords();
            if (this._actorContainsPoint(this._windowPopup, px, py))
                return Clutter.EVENT_PROPAGATE;
            if (this._popupLeader && this._actorContainsPoint(this._popupLeader, px, py))
                return Clutter.EVENT_PROPAGATE;
            this._closeWindowPopup();
            return Clutter.EVENT_PROPAGATE;
        });

        if (this._ext.getEnableAnimations()) {
            popup.opacity = 0;
            popup.translation_y = -8;
            popup.ease({
                opacity: 255,
                translation_y: 0,
                duration: POPUP_ANIM_MS * ANIM_SLOWMO,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _closeWindowPopup() {
        if (this._popupCapturedId) {
            global.stage.disconnect(this._popupCapturedId);
            this._popupCapturedId = null;
        }
        if (this._windowPopup) {
            this._windowPopup.destroy();
            this._windowPopup = null;
        }
        this._popupLeader = null;
    }

    // Rebuild the open popup after any regroup (a window closed, arrived or
    // left). Deferred one tick so row actors are never destroyed inside the
    // window-signal or DND emission that triggered the regroup; closes itself
    // when the leader is gone or the group dissolved.
    _refreshWindowPopup() {
        if (!this._windowPopup || this._popupRefreshPending) return;
        this._popupRefreshPending = true;
        this._scheduleTimeout(0, () => {
            this._popupRefreshPending = false;
            if (!this._windowPopup) return;
            let leader = this._popupLeader;
            if (!leader || !leader.get_parent() || !leader.visible) {
                this._closeWindowPopup();
                return;
            }
            let group = this._getGroupWindows(leader);
            if (group.length < 2) {
                this._closeWindowPopup();
                return;
            }
            this._windowPopup.destroy_all_children();
            for (let windowObj of group)
                this._windowPopup.add_child(this._createPopupRow(windowObj));
            this._positionWindowPopup();
        });
    }

    _positionWindowPopup() {
        let popup = this._windowPopup;
        let leader = this._popupLeader;
        if (!popup || !leader) return;

        let [lx] = leader.get_transformed_position();
        let lw = leader.get_width();
        let [, pw] = popup.get_preferred_width(-1);

        let panelBox = Main.layoutManager.panelBox;
        let [, pby] = panelBox.get_transformed_position();
        let popupY = Math.round(pby + panelBox.get_height() + 4);
        let popupX = Math.round(lx + lw / 2 - pw / 2);

        let monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            popupX = Math.max(monitor.x + 4,
                Math.min(popupX, monitor.x + monitor.width - pw - 4));
        }
        popup.set_position(popupX, popupY);
    }

    _actorContainsPoint(actor, x, y) {
        let [ax, ay] = actor.get_transformed_position();
        let [aw, ah] = actor.get_transformed_size();
        return x >= ax && x <= ax + aw && y >= ay && y <= ay + ah;
    }

    // One row per window: app icon + ellipsized title. Clicking activates that
    // window; dragging carries exactly that window, with the same DND delegate
    // contract as a bar icon, so the workspace pills and the gap-drop new-
    // workspace flow accept it unchanged.
    _createPopupRow(windowObj) {
        let iconSize = this._ext.getPreset().iconSize;
        let row = new St.BoxLayout({
            style_class: 'wsb-window-popup-item',
            reactive: true,
            track_hover: true,
        });

        let appObj = Shell.WindowTracker.get_default().get_window_app(windowObj);
        let iconTex = appObj
            ? appObj.create_icon_texture(iconSize)
            : new St.Icon({ icon_name: 'image-missing-symbolic', icon_size: iconSize });
        row.add_child(iconTex);

        let label = new St.Label({
            text: windowObj.get_title() ?? '…',
            style_class: 'wsb-window-popup-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        row.add_child(label);

        let self = this;
        row._delegate = {
            windowObj,
            actor: row,
            getDragActor() {
                return self._makeDragIcon(windowObj, iconSize, 1);
            },
            getDragActorSource() {
                return row;
            },
        };

        let draggable = DND.makeDraggable(row, {
            timeoutThreshold: TOUCH_DND_TIMEOUT_THRESHOLD,
        });
        row._draggable = draggable;
        draggable.connect('drag-begin', () => {
            self._magnifier?.beginDrag();
            row._isDragging = true;
            row.opacity = 128;
            self._registerGapDragMonitor([windowObj]);
        });
        let onDragReset = () => {
            row._isDragging = false;
            self._magnifier?.endDrag();
            row.opacity = 255;
            self._unregisterGapDragMonitor();
            self._clearDragHover();
        };
        draggable.connect('drag-cancelled', onDragReset);
        draggable.connect('drag-end', () => {
            onDragReset();
            // Deferred: never destroy the popup inside DND's own emission.
            self._scheduleTimeout(0, () => self._closeWindowPopup());
        });

        row.windowObj = windowObj;
        row._wsbPopupRow = true;
        row.connect('scroll-event', (_actor, event) => this._onScrollEvent(event));
        this._connectClick(row, (_actor, button) => {
            if (row._isDragging) return Clutter.EVENT_PROPAGATE;
            const input = self._clickInput(button);
            if (!input) return Clutter.EVENT_PROPAGATE;
            const target = {kind: 'app', actor: self._popupLeader ?? row, window: windowObj,
                windows: [windowObj], workspace: windowObj.get_workspace()};
            const action = self._gestureSettings.get_string(`gesture-app-${input}`);
            if (action !== 'none') self._closeWindowPopup();
            self._executeGestureAction(target, action);
            return Clutter.EVENT_STOP;
        });

        return row;
    }

    // ===================== GNOME SIGNALS =====================

    _connectSignals() {
        // monitors-changed → full rebuild
        this._mainEventIds.layoutManager.push(
            Main.layoutManager.connect('monitors-changed', () => {
                this.destroy(false);
                this._setup();
            })
        );

        this._connectPanelLayout();

        // Panel allocation tracks changing widget widths as well as monitors.
        this._mainEventIds.panel.push(
            Main.panel.connect('notify::width', () => this._queueAvailableWidthUpdate())
        );

        // Overview window-drag + leaving overview: reconcile sticky mirrors once
        // mutter has re-settled the dragged window onto a real workspace, so the
        // transient on-all-workspaces state during the drag can't leave its icon
        // stuck on every workspace button.
        this._mainEventIds.overview.push(
            Main.overview.connect('window-drag-end', () => this._scheduleStickyReconcile()),
            Main.overview.connect('window-drag-cancelled', () => this._scheduleStickyReconcile()),
            Main.overview.connect('hidden', () => this._scheduleStickyReconcile()),
            Main.overview.connect('showing', () => this._closeWindowPopup())
        );

        // active-workspace-changed
        this._gnomeEventIds.workspace_manager.push(
            global.workspace_manager.connect("active-workspace-changed", () => {
                // The bar may scroll to the active cell, sliding the popup's
                // anchor away from under it.
                this._closeWindowPopup();
                this._updateActiveWorkspace();
            })
        );

        // workspace-added
        this._gnomeEventIds.workspace_manager.push(
            global.workspace_manager.connect("workspace-added", (wm, wsIndex) => {
                // During a reorder, dynamic-workspaces briefly spawns a transient
                // empty workspace then removes it. Ignore those churn events — the
                // deferred rebuild produces the correct final set, and reacting here
                // would flash an extra cell right before the FLIP slide.
                if (this._reorderFlip != null) return;
                // Commit any in-flight collapse first: while a dying cell is
                // still fading, container children outnumber the real workspaces
                // and indexing children[wsIndex] would insert the new cell (and
                // splice the repr) at the wrong position. The window handlers
                // already do this; the workspace handlers must too.
                this._finalizeAllDyingCells();
                this._winIdsRepr.splice(wsIndex, 0, []);
                this._addWorkspaceButton(wsIndex);
                // During a gap-drop this button is the transient append-at-end one
                // that the deferred rebuild will replace and animate into place.
                // Keep it invisible + zero-width so it doesn't pop in abruptly.
                if (this._gapDropInProgress) {
                    let btn = this._container.get_children()[wsIndex];
                    btn.opacity = 0;
                    btn.set_width(0);
                } else {
                    // New (usually trailing, dynamic) workspace — fade + pop it in.
                    // Safe now that removals are immediate (no churn pile-up).
                    this._animateWorkspaceIn(this._container.get_children()[wsIndex]);
                }
                this._addWindowAddedEvent(wsIndex);
                // Mirror genuinely-sticky windows into the new workspace.
                // Deferred so a window mid-reassignment (which is what often
                // triggers workspace-added via gap-drop) isn't misread as sticky.
                this._scheduleStickyReconcile();
                this._scheduleSync();
            })
        );

        // workspace-removed
        this._gnomeEventIds.workspace_manager.push(
            global.workspace_manager.connect("workspace-removed", (wm, wsIndex) => {
                if (!this._container) return;
                // See workspace-added: ignore the transient churn during a reorder;
                // the deferred rebuild rebuilds the final set.
                if (this._reorderFlip != null) return;
                // Fade the cell out in place; the repr entry + actor are dropped when
                // the fade finishes (see _finalizeDyingCell), keeping the model aligned.
                this._animateWorkspaceCollapse(wsIndex);
            })
        );

        // workspaces-reordered → full rebuild
        this._gnomeEventIds.workspace_manager.push(
            global.workspace_manager.connect("workspaces-reordered", () => {
                // Deferred: the reorder fires this signal mid-operation, while the
                // moved window's workspace pointer is briefly null — which makes
                // get_tab_list report it on EVERY workspace and used to give it a
                // duplicate primary icon everywhere. Rebuilding on a later tick lets
                // the window settle so each maps to its real workspace exactly once.
                this._scheduleRebuild();
            })
        );

        // notify::focus-window → animate icon scales
        this._gnomeEventIds.display.push(
            global.display.connect('notify::focus-window', () => {
                this._onFocusWindowChanged();
            })
        );

        // window-created
        this._gnomeEventIds.display.push(
            global.display.connect('window-created', (display, newWindowObj) => {
                let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ICON_TIMEOUT, () => {
                    if (!this._container) {
                        this._glibTimeoutIds?.delete(timeoutId);
                        return GLib.SOURCE_REMOVE;
                    }
                    // Commit any in-flight workspace collapse first so container +
                    // _winIdsRepr indices line up with the real workspace_manager
                    // before we place the new icon (matters only with animations on).
                    this._finalizeAllDyingCells();

                    let newWinId, newWsIndex;
                    try {
                        newWinId = newWindowObj.get_id();
                        newWsIndex = newWindowObj.get_workspace().index();
                    } catch (err) {
                        this._glibTimeoutIds?.delete(timeoutId);
                        return GLib.SOURCE_REMOVE;
                    }

                    let wsObj = global.workspace_manager.get_workspace_by_index(newWsIndex);
                    for (let windowObj of global.display.get_tab_list(Meta.TabList.NORMAL, wsObj)) {
                        if (windowObj.get_id() === newWinId) {
                            if (newWindowObj.skip_taskbar) break;
                            if (newWsIndex < this._winIdsRepr.length) {
                                this._winIdsRepr[newWsIndex].unshift(newWinId);
                                let ic = this._addWindowIcon("l", newWindowObj, newWsIndex);
                                this._animateIconIn(ic);
                                this._connectStickyListener(newWindowObj);
                                // Defer: a freshly-mapped window often reads
                                // on-all-workspaces before mutter places it.
                                this._scheduleStickyReconcile();
                            }
                            break;
                        }
                    }

                    this._glibTimeoutIds?.delete(timeoutId);
                    return GLib.SOURCE_REMOVE;
                });

                this._glibTimeoutIds.add(timeoutId);
            })
        );

        // window-left-monitor (window closed or moved to another monitor)
        this._gnomeEventIds.display.push(
            global.display.connect('window-left-monitor', (display, oldMonitorIndex, windowObj) => {
                if (!this._container) return;
                this._finalizeAllDyingCells();

                let winIdsMeta = this._getWinIdsMeta();
                let windowId = windowObj.get_id();

                if (winIdsMeta[windowId] === undefined) return;

                let oldWsIndex = winIdsMeta[windowId].wsIndex;
                let oldWinIndex = this._winIdsRepr[oldWsIndex].indexOf(windowId);
                if (oldWinIndex < 0) return;

                let newMonitor = windowObj.get_monitor();

                if (newMonitor < 0) {
                    // Window was closed — fade its icon out in place. The repr entry
                    // and actor are removed when the fade finishes (see _animateIconOut),
                    // so the model stays aligned and the cell keeps its size meanwhile.
                    let iconsWrapper = this._container.get_children()[oldWsIndex]?._wsbIconsWrapper;
                    let icon = iconsWrapper?.get_children()[oldWinIndex];
                    // If the window was sticky, also clean up its mirror icons
                    this._removeStickyMirrors(windowId);
                    this._disconnectStickyListener(windowId);
                    if (icon) this._animateIconOut(icon, windowId);
                    else this._winIdsRepr[oldWsIndex].splice(oldWinIndex, 1);
                }
                // If window just moved to another monitor (same workspace), icon stays — nothing to do
            })
        );
    }

    _addWindowAddedEvent(wsIndex) {
        let wsObj = global.workspace_manager.get_workspace_by_index(wsIndex);

        wsObj._wsbWindowAddedId = wsObj.connect('window-added', (workspace, windowObj) => {
            if (!this._container) return;
            this._finalizeAllDyingCells();

            let windowId = windowObj.get_id();
            let winIdsMeta = this._getWinIdsMeta();

            if (winIdsMeta[windowId] === undefined) return; // New window — handled by window-created

            let oldWsIndex = winIdsMeta[windowId].wsIndex;
            let newWsIndex = workspace.index();

            if (oldWsIndex === newWsIndex) return;

            let oldWinIndex = this._winIdsRepr[oldWsIndex].indexOf(windowId);
            if (oldWinIndex < 0) return;

            this._moveWindowIcon(oldWsIndex, oldWinIndex, newWsIndex, 0);
            this._winIdsRepr[oldWsIndex].splice(oldWinIndex, 1);
            this._winIdsRepr[newWsIndex].unshift(windowId);
        });
    }

    // ===================== DND HELPERS =====================

    _clearDragHover() {
        if (!this._container) return;
        for (let btn of this._container.get_children()) {
            btn.remove_style_class_name("wsb-ws-btn-drag-hover");
        }
    }

    // Right-click context menu on a workspace cell: a single "Settings" item that
    // opens the extension preferences (the GNOME-recommended way to expose prefs).
    _openContextMenu(btnWrapper) {
        if (!Main.sessionMode.allowSettings) return; // not on the lock screen
        this._closeWindowPopup();
        if (this._windowContextMenu?.isOpen)
            this._windowContextMenu.close();
        if (!this._menuManager)
            this._menuManager = new PopupMenu.PopupMenuManager(this._container);

        // The menu is built once and kept for the bar's lifetime, like the panel's
        // own menus, and only re-anchored to the clicked cell on each open. It used
        // to be destroyed from its own 'open-state-changed' (close) handler, which
        // races GNOME 51's gesture-based PopupMenu: the item's click gesture and the
        // manager's outside-click gesture still touch the item and the BoxPointer
        // after close() returns, hitting an already-disposed object.
        if (!this._contextMenu) {
            let menu = new PopupMenu.PopupMenu(btnWrapper, 0.5, St.Side.TOP);
            // Name the extension explicitly + gear icon so it's clearly THIS extension's
            // settings, not GNOME's general Settings.
            let label = `${this._ext.metadata?.name ?? "Workspace Bar"} Preferences`;
            let item = new PopupMenu.PopupImageMenuItem(label, "preferences-system-symbolic");
            item.connect("activate", () => this._ext.openPreferences());
            menu.addMenuItem(item);

            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            this._menuManager.addMenu(menu);
            this._contextMenu = menu;
        }

        // PopupMenu.open() places the BoxPointer at menu.sourceActor.
        this._contextMenu.sourceActor = btnWrapper;
        this._contextMenu.open();
    }

    _openWindowContextMenu(sourceActor, windowObj, group) {
        if (!Main.sessionMode.allowSettings && !Main.sessionMode.hasWmMenus) return;
        this._closeWindowPopup();
        if (this._contextMenu?.isOpen)
            this._contextMenu.close();
        if (this._windowContextMenu) {
            this._windowContextMenu.destroy();
            this._windowContextMenu = null;
        }
        if (!this._menuManager)
            this._menuManager = new PopupMenu.PopupMenuManager(this._container);

        if (group && group.length >= 2) {
            this._openCombinedWindowMenu(sourceActor, group);
        } else if (windowObj) {
            this._openSingleWindowMenu(sourceActor, windowObj);
        }
    }

    _openSingleWindowMenu(sourceActor, windowObj) {
        let menu = new WindowMenu.WindowMenu(windowObj, sourceActor);
        menu._arrowAlignment = 0.5;
        this._menuManager.addMenu(menu);

        // Extension preferences item
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let label = `${this._ext.metadata?.name ?? "Workspace Bar"} Preferences`;
        let prefItem = new PopupMenu.PopupImageMenuItem(label, "preferences-system-symbolic");
        prefItem.connect("activate", () => this._ext.openPreferences());
        menu.addMenuItem(prefItem);

        let unmanagedId = windowObj.connect('unmanaged', () => {
            menu.close({ animate: false });
        });

        menu.connect('open-state-changed', (m, isOpen) => {
            if (isOpen) return;
            try { windowObj.disconnect(unmanagedId); } catch (_e) {}
            this._menuManager?.removeMenu(menu);
            if (this._windowContextMenu === menu)
                this._windowContextMenu = null;
            menu.destroy();
        });

        menu.connect('destroy', () => {
            try { windowObj.disconnect(unmanagedId); } catch (_e) {}
        });

        this._windowContextMenu = menu;
        menu.open();
    }

    _openCombinedWindowMenu(sourceActor, group) {
        let app = Shell.WindowTracker.get_default().get_window_app(group[0]);
        let appName = app ? app.get_name() : (group[0].get_title() ?? 'Application');

        let menu = new PopupMenu.PopupMenu(sourceActor, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);

        // Header: App name
        let header = new PopupMenu.PopupMenuItem(appName, { reactive: false });
        header.label.add_style_class_name('popup-subtitle-menu-item');
        menu.addMenuItem(header);

        // New Window item (if app can open new window)
        if (app && app.can_open_new_window()) {
            let newWinItem = new PopupMenu.PopupImageMenuItem(_('New Window'), 'window-new-symbolic');
            newWinItem.connect('activate', () => {
                app.open_new_window(-1);
            });
            menu.addMenuItem(newWinItem);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // List each window in the group to activate
        for (let w of group) {
            let title = w.get_title() || appName;
            let winItem = new PopupMenu.PopupMenuItem(title);
            winItem.connect('activate', () => {
                Main.activateWindow(w);
            });
            menu.addMenuItem(winItem);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Close all windows
        let closeAllItem = new PopupMenu.PopupImageMenuItem(
            `Close ${group.length} Windows`,
            'window-close-symbolic'
        );
        closeAllItem.connect('activate', () => {
            for (let w of group) {
                w.delete(global.get_current_time());
            }
        });
        menu.addMenuItem(closeAllItem);

        // Preferences item
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let label = `${this._ext.metadata?.name ?? "Workspace Bar"} Preferences`;
        let prefItem = new PopupMenu.PopupImageMenuItem(label, "preferences-system-symbolic");
        prefItem.connect("activate", () => this._ext.openPreferences());
        menu.addMenuItem(prefItem);

        menu.connect('open-state-changed', (m, isOpen) => {
            if (isOpen) return;
            this._menuManager?.removeMenu(menu);
            if (this._windowContextMenu === menu)
                this._windowContextMenu = null;
            menu.destroy();
        });

        this._windowContextMenu = menu;
        menu.open();
    }

    _scheduleWorkspaceCleanup() {
        let timeoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                Main.wm._workspaceTracker?._checkWorkspaces();
            } catch (e) {
                console.debug(`[Workspace Bar] workspace cleanup: ${e.message}`);
            }
            this._glibTimeoutIds?.delete(timeoutId);
            return GLib.SOURCE_REMOVE;
        });
        this._glibTimeoutIds.add(timeoutId);
    }

    // ===================== GAP-DROP (create new workspace between buttons) =====================

    // `windows`: every window the current drag carries — one for a plain icon
    // or a popup row, the whole group for a combined icon.
    _registerGapDragMonitor(windows) {
        if (this._gapDragMonitor) return;
        this._gapDropWindows = Array.isArray(windows) ? windows : [windows];
        this._gapDragMonitor = {
            dragMotion: (dragEvent) => this._windowIconDragMotion(dragEvent),
        };
        DND.addDragMonitor(this._gapDragMonitor);
    }

    _unregisterGapDragMonitor() {
        if (this._gapDragMonitor) {
            DND.removeDragMonitor(this._gapDragMonitor);
            this._gapDragMonitor = null;
        }
        this._removeInsertionIndicator();
        this._gapDropWindows = null;
    }

    _windowIconDragMotion(dragEvent) {
        if (!this._container) return DND.DragMotionResult.CONTINUE;
        if (!dragEvent.source?.windowObj) return DND.DragMotionResult.CONTINUE;

        let gap = this._detectGapAtPosition(dragEvent.x, dragEvent.y);

        if (gap) {
            if (this._currentInsertIndex !== gap.insertIndex) {
                this._removeInsertionIndicator();
                this._showInsertionIndicator(gap.insertIndex);
            }
            this._clearDragHover();
        } else {
            this._removeInsertionIndicator();
        }

        return DND.DragMotionResult.CONTINUE;
    }

    _detectGapAtPosition(stageX, stageY) {
        if (!this._container) return null;

        let [, containerY] = this._container.get_transformed_position();
        let containerHeight = this._container.get_height();

        if (stageY < containerY || stageY > containerY + containerHeight) return null;

        let children = this._container.get_children();
        if (children.length === 0) return null;

        for (let i = 0; i <= children.length; i++) {
            let gapCenterX;

            if (i === 0) {
                let [btnX] = children[0].get_transformed_position();
                gapCenterX = btnX;
            } else if (i === children.length) {
                let [btnX] = children[i - 1].get_transformed_position();
                gapCenterX = btnX + children[i - 1].get_width();
            } else {
                let [prevX] = children[i - 1].get_transformed_position();
                let prevW = children[i - 1].get_width();
                let [nextX] = children[i].get_transformed_position();
                gapCenterX = (prevX + prevW + nextX) / 2;
            }

            if (Math.abs(stageX - gapCenterX) <= GAP_HALF_WIDTH) {
                return { insertIndex: i };
            }
        }

        return null;
    }

    _showInsertionIndicator(insertIndex) {
        this._removeInsertionIndicator();

        let [containerX, containerY] = this._container.get_transformed_position();
        let containerHeight = this._container.get_height();
        let children = this._container.get_children();

        let indicatorX;
        if (children.length === 0) {
            indicatorX = containerX;
        } else if (insertIndex === 0) {
            let [btnX] = children[0].get_transformed_position();
            indicatorX = btnX - 2;
        } else if (insertIndex >= children.length) {
            let [btnX] = children[children.length - 1].get_transformed_position();
            indicatorX = btnX + children[children.length - 1].get_width() + 2;
        } else {
            let [prevX] = children[insertIndex - 1].get_transformed_position();
            let prevW = children[insertIndex - 1].get_width();
            let [nextX] = children[insertIndex].get_transformed_position();
            indicatorX = (prevX + prevW + nextX) / 2 - 1;
        }

        let inset = 4;
        let hitAreaWidth = GAP_HALF_WIDTH * 2;

        this._insertionIndicator = new St.Widget({
            width: hitAreaWidth,
            height: containerHeight - inset * 2,
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
            // Near-invisible background so Clutter picks this actor for DnD targeting
            style: 'background-color: rgba(0, 0, 0, 0.01);',
        });

        let visualBar = new St.Widget({
            style_class: 'wsb-insertion-indicator',
            width: 5,
            style: 'background-color: white;',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._insertionIndicator.add_child(visualBar);

        let self = this;
        this._insertionIndicator._delegate = {
            acceptDrop(source) {
                if (!source.windowObj || !self._gapDropWindows?.length) return false;

                let windows = self._gapDropWindows;
                let idx = self._currentInsertIndex;

                self._removeInsertionIndicator();

                // Mark the gap-drop so the intermediate append-at-end button stays
                // hidden and the deferred rebuild animates the new cell into place.
                self._gapDropInProgress = true;
                self._pendingGapAnim = windows[0].get_id();

                let numWs = global.workspace_manager.get_n_workspaces();
                global.workspace_manager.append_new_workspace(false, global.get_current_time());
                let newWsObj = global.workspace_manager.get_workspace_by_index(numWs);
                for (let w of windows)
                    w.change_workspace(newWsObj);
                global.workspace_manager.reorder_workspace(newWsObj, idx);
                newWsObj.activate(global.get_current_time());
                self._scheduleWorkspaceCleanup();
                self._scheduleStickyReconcile();
                // Always schedule the rebuild ourselves: a far-right drop reorders
                // the new ws to the index it's ALREADY at (no-op), so
                // 'workspaces-reordered' never fires — without this the rebuild that
                // reveals the hidden cell + resets _gapDropInProgress would never run,
                // leaving the app icon hidden and every later workspace hidden too.
                // (_scheduleRebuild guards against running twice.)
                self._scheduleRebuild();

                return true;
            },
            handleDragOver(source) {
                if (source.windowObj) return DND.DragMotionResult.MOVE_DROP;
                return DND.DragMotionResult.CONTINUE;
            },
        };

        Main.uiGroup.add_child(this._insertionIndicator);
        this._insertionIndicator.set_position(
            indicatorX - Math.floor(hitAreaWidth / 2),
            containerY + inset
        );

        this._currentInsertIndex = insertIndex;
    }

    _removeInsertionIndicator() {
        if (this._insertionIndicator) {
            let parent = this._insertionIndicator.get_parent();
            if (parent) parent.remove_child(this._insertionIndicator);
            this._insertionIndicator.destroy();
            this._insertionIndicator = null;
            this._currentInsertIndex = -1;
        }
    }
}
