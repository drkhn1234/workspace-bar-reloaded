import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Cairo from 'cairo';
import PangoCairo from 'gi://PangoCairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import {centerGlyph, computeMagnificationLayout, containsPoint, opticalGlyphCenter} from './magnificationLayout.js';
import {easeMagnification, peakIconSize, readFocusHighlightOptions} from './magnificationSettings.js';
import {dominantIconTint, visibleIconBounds, focusShadowGeometry, focusHighlightColor} from './iconTint.js';
import {focusHighlightGradient, relativeLuminance} from './highlightColor.js';

const FRAME_MS = 16;
const opticalCenters = new Map();

function rect(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
}

export default class DockMagnifier {
    constructor(bar) {
        this._bar = bar;
        this._entries = new Map();
        this._amount = 0;
        this._active = false;
        this._dragging = false;
        this._blockedUntilLeave = false;
        this._timer = null;
        this._transition = null;
        this._destroyed = false;
        this._envelope = null;
        this._clickHold = null;
        this._lastPointerX = null;
        this._iconTints = new Map();
        this._tintGeneration = 0;
        this._tintCancellable = new Gio.Cancellable();
        this._iconTheme = St.IconTheme.new();
        this._iconThemeId = this._iconTheme.connect('changed', () => {
            this._iconTints.clear(); this._tintGeneration++;
        });
        this._highlightSettings = bar._ext.getSettings();
        if (!this._highlightSettings.settings_schema.has_key('magnification-focus-highlight-enabled')) {
            const source = Gio.SettingsSchemaSource.new_from_directory(`${bar._ext.path}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
            this._highlightSettings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.workspace-bar', false)});
        }
        this._highlightOptions = null;
        this._highlightSettingsId = this._highlightSettings.connect('changed', (_settings, key) => {
            if (!key.startsWith('magnification-focus-highlight-')) return;
            this._highlightOptions = null; this.settingsChanged();
        });
        this._overlay = new St.Widget({
            name: 'workspace-bar-magnifier', reactive: false,
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: false, visible: false,
        });
        Main.uiGroup.add_child(this._overlay);
        this._focusShadows = new St.Widget({reactive: false,
            layout_manager: new Clutter.FixedLayout(), clip_to_allocation: false});
        this._overlay.add_child(this._focusShadows);
        this._panelTargets = new St.Widget({reactive: false,
            layout_manager: new Clutter.FixedLayout(), clip_to_allocation: false});
        this._overlay.add_child(this._panelTargets);
        this._overlay.connect('scroll-event', (_actor, event) => {
            return this._bar._onScrollEvent(event);
        });

        this._legacySignals = [];
        this._motions = [];
        this._connectMotion(bar._viewport);
        this._connectMotion(this._overlay);
    }

    _connectMotion(actor) {
        if (Clutter.MotionController) {
            const motion = new Clutter.MotionController();
            for (const signal of ['enter', 'motion', 'leave'])
                motion.connect(signal, (_controller, sprite) => {
                    const coords = sprite.get_coords();
                    this.refresh(coords.x, coords.y);
                });
            actor.add_action(motion);
            this._motions.push([actor, motion]);
        } else {
            for (const event of ['enter-event', 'motion-event', 'leave-event'])
                this._legacySignals.push([actor, actor.connect(event, (_actor, event) => {
                    const [x, y] = event.get_coords();
                    this.refresh(x, y);
                    return Clutter.EVENT_PROPAGATE;
                })]);
        }
    }

    refresh(x, y) {
        if (this._destroyed) return;
        this._checkPointer(x, y);
        if (this._active || this._amount > 0 || this._blockedUntilLeave)
            this._ensureTimer();
    }

    settingsChanged(rebuild = false) {
        this._settingsDirty ||= rebuild;
        this.refresh();
        if (this._settingsDirty) this._ensureTimer();
    }

    _progress(start, now = GLib.get_monotonic_time()) {
        const options = this._bar._ext.getMagnificationOptions();
        const duration = St.Settings.get().enable_animations ? options.duration : 0;
        return duration === 0 ? 1 : Math.min(1, (now - start) / (duration * 1000));
    }

    _ease(progress) {
        return easeMagnification(progress, this._bar._ext.getMagnificationOptions().easing);
    }

    beginDrag() {
        if (this._destroyed) return;
        this._dragging = true;
        this._clickHold = null;
        this._blockedUntilLeave = true;
        this._bar._viewport.add_style_class_name('wsb-drag-mode');
        // Keep the transparent proxy mapped until DND finishes using it.
        this._setActive(false, true);
        this._ensureTimer();
    }

    endDrag() {
        if (this._destroyed) return;
        this._dragging = false;
        this._blockedUntilLeave = true;
        this._bar._viewport.remove_style_class_name('wsb-drag-mode');
        this._ensureTimer();
    }

    suspend() {
        if (this._destroyed) return;
        this._blockedUntilLeave = true;
        this._clickHold = null;
        this._setActive(false, true);
        this._ensureTimer();
    }

    _sources() {
        const clip = rect(this._bar._clip);
        const sources = [];
        for (const button of this._bar._container.get_children()) {
            if (!button.visible || !button._wsbIconsWrapper) continue;
            const items = [button._wsbNumWrapper,
                ...button._wsbIconsWrapper.get_children()];
            for (const source of items) {
                if (!source.visible || !source.mapped
                    || (!source.windowObj && !source._wsbWorkspaceButton)
                    || source._wsbClosing || source._isDragging) continue;
                const bounds = rect(source);
                if (bounds.width > 0 && bounds.height > 0
                    && bounds.x < clip.x + clip.width
                    && bounds.x + bounds.width > clip.x)
                    sources.push(source);
            }
        }
        return sources;
    }

    _checkPointer(x, y) {
        if (x === undefined || y === undefined) [x, y] = global.get_pointer();
        if (this._dragging) return;
        if (!this._bar._ext.getMagnificationOptions().enabled) {
            this._setActive(false, true);
            return;
        }
        if (this._active && this._hasOpenMenu()) return;
        // Switching workspace briefly grabs the stage. A click on this dock
        // should retain its hover state through that animation, while other
        // shell dialogs still dismiss it.
        const switchModal = this._active && this._clickHold
            && Main.wm._workspaceAnimation?._grab ? 1 : 0;
        if (Main.modalCount > (Main.overview.visible ? 1 : 0) + switchModal) {
            this._setActive(false);
            return;
        }
        if (this._blockedUntilLeave) {
            if (!containsPoint(rect(this._bar._viewport), x, y))
                this._blockedUntilLeave = false;
            else return;
        }
        if (this._clickHold) {
            if (Math.hypot(x - this._clickHold.x, y - this._clickHold.y) <= 1) return;
            this._clickHold = null;
        }
        const overOverlay = this._active && this._envelope
            && containsPoint(this._envelope, x, y);
        this._setActive(containsPoint(rect(this._bar._viewport), x, y) || overOverlay);
    }

    _setActive(active, immediate = false) {
        if (active && !this._sources().length) active = false;
        if (active !== this._active) {
            this._active = active;
            if (active) {
                this._syncEntries();
                this._overlay.show();
                Main.uiGroup.set_child_above_sibling(this._overlay, null);
                this._bar._viewport.add_style_class_name('wsb-dock-mode');
            } else {
                this._clickHold = null;
                this._bar._viewport.remove_style_class_name('wsb-dock-mode');
                for (const entry of this._entries.values()) {
                    entry.proxy.reactive = false; entry.panelTarget.reactive = false;
                }
            }
            this._transition = {from: this._amount, to: active ? 1 : 0,
                start: GLib.get_monotonic_time()};
        }
        if (immediate || St.Settings.get().enable_animations === false) {
            this._amount = active ? 1 : 0;
            this._transition = null;
            this._draw();
            // A click or a gesture can be emitting on a proxy right now. Its
            // destruction is deferred to the next timer iteration.
        }
    }

    _ensureTimer() {
        if (this._timer !== null || this._destroyed) return;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            this._checkPointer();
            if (this._transition) {
                const {from, to, start} = this._transition;
                const progress = this._progress(start);
                this._amount = from + (to - from) * this._ease(progress);
                if (progress === 1) this._transition = null;
            }
            if (this._settingsDirty && !this._dragging) {
                this._clearEntries();
                this._settingsDirty = false;
                if (this._active) this._overlay.show();
            }
            if (this._active) this._syncEntries();
            this._draw();
            if (!this._active && this._amount === 0 && !this._dragging)
                this._clearEntries();
            if (!this._active && this._amount === 0
                && !this._dragging && !this._blockedUntilLeave) {
                this._timer = null;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _syncEntries() {
        const sources = new Set(this._sources());
        for (const [source, entry] of this._entries) {
            if (!sources.has(source)) {
                this._removeEntry(entry);
                this._entries.delete(source);
            }
        }
        for (const source of sources) {
            if (!this._entries.has(source)) {
                this._entries.set(source, this._createEntry(source));
            } else {
                const entry = this._entries.get(source);
                if (entry.workspaceButton) {
                    const text = `${entry.workspaceButton.wsIndex + 1}`;
                    if (entry.label.text !== text) {
                        entry.label.text = text;
                        entry.ordinalDirty = true;
                    }
                    this._setRingActive(entry, this._bar._ext.getShowActiveWorkspaceRing()
                        && entry.workspaceButton.wsIndex
                        === global.workspace_manager.get_active_workspace_index());
                    continue;
                }
                const count = this._bar._getGroupWindows(source).length;
                if (entry.count !== count) {
                    entry.proxy.destroy_all_children();
                    entry.proxy.add_child(this._bar._makeDragIcon(source.windowObj,
                        this._maxSize(), count));
                    entry.count = count;
                }
            }
        }
    }

    _createEntry(source) {
        const bar = this._bar;
        const size = this._maxSize();
        const workspaceButton = source._wsbWorkspaceButton ?? null;
        const sourceRect = rect(source);
        const canvasHeight = workspaceButton
            ? size * sourceRect.height / sourceRect.width : size;
        const proxy = new St.Widget({
            style_class: 'wsb-magnified-icon', reactive: false, opacity: 0,
            width: size, height: canvasHeight,
            layout_manager: workspaceButton ? new Clutter.FixedLayout() : new Clutter.BinLayout(),
        });
        const group = workspaceButton ? [] : bar._getGroupWindows(source);
        const entry = {source, proxy, opacity: source.opacity, destroyId: null,
            count: group.length, workspaceButton,
            canvasWidth: size, canvasHeight, ordinalDirty: true};
        // This transparent input strip gives the screen edge the same source
        // and drag gesture as the magnified item above or below it.
        entry.panelTarget = new St.Widget({name: 'workspace-bar-magnified-panel-target', reactive: false});
        this._panelTargets.add_child(entry.panelTarget);
        if (workspaceButton) {
            entry.content = new St.Widget({width: size, height: canvasHeight,
                layout_manager: new Clutter.FixedLayout()});
            proxy.add_child(entry.content);
            const color = source.get_theme_node().get_foreground_color();
            const options = bar._ext.getMagnificationOptions();
            const diameter = Math.max(options.circleWidth * 2 + 2,
                Math.min(size, canvasHeight) - options.circlePadding * 2);
            entry.ringActive = bar._ext.getShowActiveWorkspaceRing() && workspaceButton.wsIndex
                === global.workspace_manager.get_active_workspace_index();
            entry.ringAmount = entry.ringActive ? 1 : 0;
            entry.ring = new St.Widget({
                style_class: 'wsb-active-ordinal-ring',
                width: diameter, height: diameter,
                visible: entry.ringActive,
            });
            entry.ring.set_pivot_point(0.5, 0.5);
            entry.content.add_child(entry.ring);
            entry.label = new St.Label({
                text: `${workspaceButton.wsIndex + 1}`,
                style_class: 'wsb-magnified-number',
                style: `font-size: ${bar._ext.getPreset().fontSize * size / sourceRect.width}px;`
                    + `color: rgba(${color.red},${color.green},${color.blue},${color.alpha / 255});`,
            });
            entry.content.add_child(entry.label);
            entry.label.connect('style-changed', () => { entry.ordinalDirty = true; });
        } else {
            proxy.add_child(bar._makeDragIcon(source.windowObj, size, group.length));
            entry.focusShadow = new St.DrawingArea({reactive: false, visible: false});
            entry.focusShadow.connect('repaint', area => {
                const context = area.get_context(), [width, height] = area.get_surface_size();
                try {
                    context.translate(width / 2, height / 2);
                    context.scale(width / 2, height / 2);
                    const gradient = new Cairo.RadialGradient(0, 0, 0, 0, 0, 1);
                    for (const {position, alpha, color} of entry.highlightGradient)
                        gradient.addColorStopRGBA(position, color.red / 255, color.green / 255, color.blue / 255, alpha);
                    context.setSource(gradient);
                    context.arc(0, 0, 1, 0, Math.PI * 2); context.fill();
                } finally {context.$dispose();}
            });
            this._focusShadows.add_child(entry.focusShadow);
        }
        if (source.get_transition('opacity')) {
            source.remove_transition('opacity');
            entry.opacity = 255;
        }
        entry.destroyId = source.connect('destroy', () => {
            entry.source = null;
            proxy.reactive = false; entry.panelTarget.reactive = false;
        });
        proxy._delegate = workspaceButton ? {
            actor: workspaceButton, wsButton: true,
            getDragActor: () => workspaceButton._delegate.getDragActor(),
            getDragActorSource: () => source,
            handleDragOver: (...args) => workspaceButton._delegate.handleDragOver(...args),
            acceptDrop: (...args) => workspaceButton._delegate.acceptDrop(...args),
        } : {
            actor: proxy, windowObj: source.windowObj,
            getDragActor: () => bar._makeDragIcon(source.windowObj,
                bar._ext.getPreset().iconSize, bar._getGroupWindows(source).length),
            getDragActorSource: () => source,
        };
        entry.panelTarget._delegate = proxy._delegate;
        this._connectEntryInput(entry, entry.panelTarget);
        this._connectEntryInput(entry, proxy);
        this._overlay.add_child(proxy);
        return entry;
    }

    _connectEntryInput(entry, input) {
        const {source, proxy, workspaceButton} = entry, bar = this._bar;
        input.connect('scroll-event', (_actor, event) => bar._onScrollEvent(event));
        const draggable = DND.makeDraggable(input, {timeoutThreshold: bar._ext.getMagnificationOptions().dragDelay});
        input._draggable = draggable;
        draggable.connect('drag-begin', () => {
            if (this._destroyed || !entry.source) return;
            proxy._isDragging = true; entry.panelTarget._isDragging = true;
            this.beginDrag();
            bar._closeWindowPopup();
            if (workspaceButton) {
                workspaceButton._isDragging = true;
                workspaceButton.opacity = 128;
            } else {
                const windows = bar._getGroupWindows(source);
                proxy._delegate.wsbGroupWindows = windows;
                bar._registerGapDragMonitor(windows);
            }
        });
        draggable.connect('drag-cancelled', () => {
            if (!this._destroyed) bar._clearDragHover();
        });
        draggable.connect('drag-end', () => {
            if (this._destroyed) return;
            if (!entry.source) {
                bar._unregisterGapDragMonitor();
                bar._clearDragHover();
                this.endDrag();
                return;
            }
            proxy._isDragging = false; entry.panelTarget._isDragging = false;
            if (workspaceButton) {
                workspaceButton._isDragging = false;
                workspaceButton.opacity = 255;
            } else {
                proxy._delegate.wsbGroupWindows = null;
                bar._unregisterGapDragMonitor();
            }
            bar._clearDragHover();
            this.endDrag();
        });
        bar._connectClick(input, (_actor, button, x, y) => {
            if (this._destroyed || !entry.source || proxy._isDragging)
                return Clutter.EVENT_STOP;
            const [pointerX, pointerY] = global.get_pointer();
            this._clickHold = {x: pointerX, y: pointerY};
            if (workspaceButton) {
                bar._handleWorkspaceClick(workspaceButton, button);
                return Clutter.EVENT_STOP;
            }
            bar._handleIconClick(source, button, x, y);
            return Clutter.EVENT_STOP;
        });
    }

    _maxSize() {
        const options = this._bar._ext.getMagnificationOptions();
        return peakIconSize(options, this._bar._ext.getPreset().iconSize);
    }

    _focusIcon(entry) {
        const icon = entry.source._iconTex;
        const gicon = icon?.get_gicon?.()
            ?? new Gio.ThemedIcon({name: icon?.get_icon_name?.() ?? 'image-missing-symbolic'});
        const key = gicon.to_string() ?? gicon;
        if (!this._iconTints.has(key)) {
            const foreground = entry.source.get_theme_node().get_foreground_color();
            const fallback = {red: foreground.red, green: foreground.green, blue: foreground.blue};
            if (this._iconTints.size >= 128) this._iconTints.delete(this._iconTints.keys().next().value);
            this._iconTints.set(key, {tint: fallback, bounds: null});
            const generation = this._tintGeneration;
            try {
                const info = this._iconTheme.lookup_by_gicon(gicon, 96, St.IconLookupFlags.FORCE_SIZE);
                if (info) info.load_icon_async(this._tintCancellable, (info, result) => {
                    try {
                        const pixbuf = info.load_icon_finish(result);
                        if (this._destroyed || generation !== this._tintGeneration) return;
                        const sample = [pixbuf.get_pixels(), pixbuf.get_width(), pixbuf.get_height(),
                            pixbuf.get_rowstride(), pixbuf.get_n_channels()];
                        const tint = info.is_symbolic() ? fallback : dominantIconTint(...sample) ?? fallback;
                        this._iconTints.set(key, {tint, bounds: visibleIconBounds(...sample)});
                    } catch { /* Keep a neutral marker if the icon cannot be loaded. */ }
                });
            } catch { /* Fileless/window-provided icons use their foreground colour. */ }
        }
        return this._iconTints.get(key);
    }

    _highlightBackdrop() {
        const panel = Main.panel.get_theme_node().get_background_color();
        const foreground = this._bar._viewport.get_theme_node().get_foreground_color();
        // Transparent panels have no single opaque backdrop to measure. Use the
        // panel's text contrast as a theme hint rather than sampling the screen.
        const fallback = relativeLuminance(foreground) < 0.18 ? 255 : 0, alpha = panel.alpha / 255;
        return Object.fromEntries(['red', 'green', 'blue'].map(channel =>
            [channel, Math.round(panel[channel] * alpha + fallback * (1 - alpha))]));
    }

    _drawFocusShadow(entry, target, monitor) {
        if (!entry.focusShadow) return;
        const options = this._highlightOptions ??= readFocusHighlightOptions(this._highlightSettings);
        const focused = entry.source.windowId === this._bar._focusedWindowId
            || (entry.source._wsbGroupIds?.includes(this._bar._focusedWindowId) ?? false);
        entry.focusShadow.visible = focused && this._amount > 0 && options.focusHighlightEnabled && options.focusHighlightOpacity > 0;
        if (!entry.focusShadow.visible) return;
        const icon = this._focusIcon(entry);
        const tint = focusHighlightColor(icon.tint, options.focusHighlightColorMode === 'accent' ? this._bar._ext._getAccentColor() : null, options);
        const background = options.focusHighlightColorMode === 'icon' ? this._highlightBackdrop() : null;
        const paint = [tint.red, tint.green, tint.blue, options.focusHighlightOpacity, options.focusHighlightSoftness,
            options.focusHighlightColorMode, background?.red, background?.green, background?.blue].join(':');
        entry.focusTint = tint; entry.highlightOptions = options;
        if (entry.highlightPaint !== paint) {
            entry.highlightPaint = paint; entry.highlightGradient = focusHighlightGradient(tint, options, background);
            entry.focusShadow.queue_repaint();
        }
        const geometry = focusShadowGeometry(target, icon.bounds, monitor, options);
        const [, x, y] = Main.uiGroup.transform_stage_point(geometry.x, geometry.y);
        entry.focusShadow.set_position(x, y);
        entry.focusShadow.set_size(geometry.width, geometry.height);
        entry.focusShadow.opacity = entry.proxy.opacity;
    }

    _hasOpenMenu() {
        return this._bar._windowPopup?.visible || this._bar._windowContextMenu?.isOpen
            || this._bar._contextMenu?.isOpen;
    }

    _updateRingAmount(entry, now = GLib.get_monotonic_time()) {
        if (entry.ringTransition) {
            const {from, to, start} = entry.ringTransition;
            const progress = this._progress(start, now);
            entry.ringAmount = from + (to - from) * this._ease(progress);
            if (progress === 1) entry.ringTransition = null;
        }
    }

    _setRingActive(entry, active, now = GLib.get_monotonic_time()) {
        if (entry.ringActive === active) return;
        // A reversal starts at the displayed size, including rapid workspace
        // switches, rather than restarting at a fully visible or hidden ring.
        this._updateRingAmount(entry, now);
        entry.ringActive = active;
        entry.ringTransition = {from: entry.ringAmount, to: active ? 1 : 0, start: now};
    }

    _positionWorkspaceNumber(entry, now = GLib.get_monotonic_time()) {
        entry.label.ensure_style();
        const text = entry.label.clutter_text;
        const resourceScale = Math.max(1, text.get_resource_scale());
        const dirty = entry.ordinalDirty || entry.ordinalResourceScale !== resourceScale;
        if (dirty) {
            const [ink, logical] = text.get_layout().get_pixel_extents();
            if (ink.width <= 0 || ink.height <= 0) return;
            // Pango extents use device pixels; actors use logical coordinates.
            entry.label.set_size(logical.width / resourceScale, logical.height / resourceScale);
            const position = centerGlyph(ink, entry.canvasWidth, entry.canvasHeight, resourceScale);
            entry.label.set_position(position.x, position.y);
            entry.ordinalInk = ink;
            entry.opticalCenter = null;
            entry.ordinalDirty = false;
            entry.ordinalResourceScale = resourceScale;
        }
        const options = this._bar._ext.getMagnificationOptions();
        this._updateRingAmount(entry, now);
        entry.ring.visible = entry.ringAmount > 0;
        entry.ring.set_scale(entry.ringAmount, entry.ringAmount);
        entry.ring.opacity = Math.round(options.circleOpacity * entry.ringAmount * 255);
        if (!entry.ring.visible) return;
        const ink = entry.ordinalInk;
        if (!entry.opticalCenter) {
            const key = `${text.get_font_name()}:${entry.label.text}:${resourceScale}:`
                + `${ink.x},${ink.y},${ink.width},${ink.height}`;
            if (!opticalCenters.has(key)) {
                // Measure the font outline once per glyph/style, without
                // reading the screen or rendering a separate bitmap.
                const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
                const context = new Cairo.Context(surface);
                try {
                    PangoCairo.layout_path(context, text.get_layout());
                    opticalCenters.set(key, opticalGlyphCenter(ink, (x, y) => context.inFill(x, y)));
                } finally {
                    context.$dispose();
                }
                if (opticalCenters.size > 128) opticalCenters.delete(opticalCenters.keys().next().value);
            }
            entry.opticalCenter = opticalCenters.get(key);
        }
        const offsetX = (entry.opticalCenter.x - ink.x - ink.width / 2) / resourceScale * options.opticalStrength;
        const offsetY = (entry.opticalCenter.y - ink.y - ink.height / 2) / resourceScale * options.opticalStrength;
        entry.ring.set_position((entry.canvasWidth - entry.ring.width) / 2 + offsetX,
            (entry.canvasHeight - entry.ring.height) / 2 + offsetY);
        entry.ring.x += options.circleOffsetX;
        entry.ring.y += options.circleOffsetY;
    }

    _freeBounds() {
        const panel = rect(Main.panel);
        const viewport = rect(this._bar._viewport);
        let left = panel.x;
        let right = panel.x + panel.width;
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]) {
            for (const child of box.get_children()) {
                if (child === this._bar._viewport || !child.visible) continue;
                const bounds = rect(child);
                if (bounds.width <= 0) continue;
                if (bounds.x + bounds.width <= viewport.x + 1)
                    left = Math.max(left, bounds.x + bounds.width + 6);
                else if (bounds.x >= viewport.x + viewport.width - 1)
                    right = Math.min(right, bounds.x - 6);
            }
        }
        return {left, right};
    }

    _ordinalInsets(entry, sourceWidth, now = GLib.get_monotonic_time()) {
        this._positionWorkspaceNumber(entry, now);
        const ink = entry.ordinalInk;
        if (!ink) return {left: 0, right: 0};
        const options = this._bar._ext.getMagnificationOptions();
        if (!options.trimNumbers) return {left: 0, right: 0};
        const resourceScale = entry.ordinalResourceScale;
        let left = entry.label.x + ink.x / resourceScale;
        let right = left + ink.width / resourceScale;
        if (entry.ring.visible) {
            // Reserve exactly the currently painted circle, using the same
            // progress for its size, opacity and surrounding space.
            const inset = entry.ring.width * (1 - entry.ringAmount) / 2;
            left = Math.min(left, entry.ring.x + inset);
            right = Math.max(right, entry.ring.x + entry.ring.width - inset);
        }
        const padding = options.numberPadding * entry.canvasWidth / sourceWidth;
        return {left: (left - padding) * sourceWidth / entry.canvasWidth,
            right: (entry.canvasWidth - right - padding) * sourceWidth / entry.canvasWidth};
    }

    _hoveredWorkspace(entries, x, y) {
        // Magnified proxies can cover a different native cell. Prefer what
        // is visibly under the pointer over the faded panel underneath.
        for (const entry of entries) {
            if (entry.proxy.reactive && containsPoint(rect(entry.proxy), x, y))
                return entry.workspaceButton?._wsbIconsWrapper ?? entry.source.get_parent();
        }
        if (containsPoint(rect(this._bar._viewport), x, y)) {
            for (const button of this._bar._container.get_children()) {
                if (button.visible && containsPoint(rect(button), x, y))
                    return button._wsbIconsWrapper;
            }
        }
        return null;
    }

    _independentNumberHover(entry, hoveredWorkspace, now) {
        const target = entry.workspaceButton._wsbIconsWrapper === hoveredWorkspace ? 1 : 0;
        entry.independentHover ??= 0;
        if (target !== entry.independentHoverTarget) {
            entry.independentHoverTarget = target;
            entry.independentHoverTransition = {from: entry.independentHover, start: now};
        }
        if (entry.independentHoverTransition) {
            const {from, start} = entry.independentHoverTransition;
            const progress = this._progress(start, now);
            entry.independentHover = from + (target - from) * this._ease(progress);
            if (progress === 1) entry.independentHoverTransition = null;
        }
        return entry.independentHover;
    }

    _draw() {
        const entries = [...this._entries.values()].filter(entry => entry.source);
        const options = this._bar._ext.getMagnificationOptions();
        this._bar._container.opacity = Math.round(255 * (1 - this._amount));
        if (!entries.length) { this._envelope = null; return; }
        const [currentX, currentY] = global.get_pointer();
        const pointerX = this._hasOpenMenu() && this._lastPointerX !== null
            ? this._lastPointerX : currentX;
        this._lastPointerX = pointerX;
        const hoveredWorkspace = this._hoveredWorkspace(entries, currentX, currentY);
        const now = GLib.get_monotonic_time();
        const {left, right} = this._freeBounds();
        const panel = rect(Main.panel);
        const monitor = Main.layoutManager.findMonitorForActor(Main.panel)
            ?? Main.layoutManager.primaryMonitor;
        const bottom = panel.y + panel.height / 2 > monitor.y + monitor.height / 2;
        const layout = computeMagnificationLayout({
            ...options,
            icons: entries.map(entry => {
                const bounds = rect(entry.source);
                return {...bounds, isWorkspaceNumber: !!entry.workspaceButton,
                    workspace: entry.workspaceButton?._wsbIconsWrapper ?? entry.source.get_parent(),
                    independentHover: entry.workspaceButton
                        ? this._independentNumberHover(entry, hoveredWorkspace, now) : undefined,
                    contentInsets: entry.workspaceButton ? this._ordinalInsets(entry, bounds.width) : null};
            }), pointerX,
            progress: this._amount, maxSize: this._maxSize(), left, right, bottom,
            spacing: this._bar._ext.getMagnificationSpacing(),
            appSpacing: this._bar._ext.getPreset().iconSpacing,
        });
        const [, clipX, clipY] = Main.uiGroup.transform_stage_point(left, monitor.y);
        this._overlay.set_clip(clipX, clipY, Math.max(0, right - left), monitor.height);
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const target = layout[i];
            if (!target) continue;
            const scale = target.width / entry.canvasWidth;
            if (entry.workspaceButton) {
                entry.content.set_position(-target.leftInset / scale, 0);
                entry.proxy.width = entry.canvasWidth - (target.leftInset + target.rightInset) / scale;
            }
            const [, x, y] = Main.uiGroup.transform_stage_point(target.x + target.leftInset, target.y);
            entry.proxy.set_position(x, y);
            entry.proxy.scale_x = scale;
            entry.proxy.scale_y = target.height / entry.canvasHeight;
            entry.proxy.opacity = Math.round(255 * this._amount
                * (entry.workspaceButton ? options.numberOpacity : options.iconOpacity));
            this._drawFocusShadow(entry, target, monitor);
            entry.proxy.reactive = this._active && !this._dragging;
            const panelLeft = Math.max(left, target.x + target.leftInset);
            const panelRight = Math.min(right, target.x + target.width - target.rightInset);
            const [, hitX, hitY] = Main.uiGroup.transform_stage_point(panelLeft, panel.y);
            entry.panelTarget.set_position(hitX, hitY);
            entry.panelTarget.set_size(Math.max(0, panelRight - panelLeft), panel.height);
            entry.panelTarget.reactive = entry.proxy.reactive && entry.proxy.opacity > 0 && panelRight > panelLeft;
            if (!entry.source._wsbClosing) {
                if (entry.workspaceButton)
                    entry.workspaceButton._wsbNumLabel.opacity = Math.round(255 * (1 - this._amount));
                else
                    entry.source.opacity = Math.round(entry.opacity * (1 - this._amount));
            }
        }
        if (layout.length) {
            const x = Math.max(left, Math.min(...layout.map(icon => icon.x + icon.leftInset)) - 6);
            const y = Math.min(...layout.map(icon => icon.y)) - 6;
            this._envelope = {x, y,
                width: Math.max(0, Math.min(right,
                    Math.max(...layout.map(icon => icon.x + icon.width - icon.rightInset)) + 6) - x),
                height: Math.max(...layout.map(icon => icon.y + icon.height)) + 6 - y};
        }
    }

    _removeEntry(entry) {
        if (entry.source) {
            entry.source.disconnect(entry.destroyId);
            if (!entry.source._wsbClosing) entry.source.opacity = entry.opacity;
            if (entry.workspaceButton) entry.workspaceButton._wsbNumLabel.opacity = 255;
        }
        entry.source = null;
        entry.focusShadow?.destroy();
        entry.panelTarget.destroy();
        entry.proxy.destroy();
    }

    _clearEntries() {
        for (const entry of this._entries.values()) this._removeEntry(entry);
        this._entries.clear();
        this._envelope = null;
        this._overlay.hide();
    }

    destroy() {
        this._destroyed = true;
        this._tintCancellable.cancel();
        this._highlightSettings.disconnect(this._highlightSettingsId);
        this._iconTheme.disconnect(this._iconThemeId);
        this._iconTints.clear();
        if (this._timer !== null) GLib.Source.remove(this._timer);
        this._timer = null;
        for (const [actor, motion] of this._motions) actor.remove_action(motion);
        for (const [actor, id] of this._legacySignals) actor.disconnect(id);
        this._bar._viewport.remove_style_class_name('wsb-dock-mode');
        this._bar._viewport.remove_style_class_name('wsb-drag-mode');
        this._bar._container.opacity = 255;
        this._clearEntries();
        this._overlay.destroy();
        this._bar = null;
    }
}
