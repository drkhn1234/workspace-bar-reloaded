import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import {magnificationGraphModel, magnificationGraphViewport} from './magnificationGraphModel.js';
import {readMagnificationOptions, sizePreset, peakIconSize} from './magnificationSettings.js';

const TOOLS = {
    peak: ['Size', 'Drag the peak up or down to change the largest icon size.'],
    compression: ['Width', 'Drag a width handle sideways to narrow or widen the magnified row.'],
    shape: ['Shape', 'Drag either shoulder up or down to change the shape of the curve.'],
    marker: ['Spacing', 'Drag an enlarged app sideways to adjust spacing on both sides.'],
    cutoff: ['Cutoff', 'Drag a boundary sideways. Icons beyond it use normal size and spacing.'],
};

export function createMagnificationGraph(settings, {group = null, previewControls = null, placementControls = null, headerRow = null, onPlacementWrapped = null} = {}) {
    const box = group ?? new Adw.PreferencesGroup();
    box.set_name('magnification-editor-list');
    if (headerRow) box.add(headerRow);
    const toolbar = new Adw.WrapBox({name: 'magnification-tools',
        child_spacing: 8, line_spacing: 8, halign: Gtk.Align.START,
        accessible_role: Gtk.AccessibleRole.TOOLBAR});
    const controlHeights = new Gtk.SizeGroup({mode: Gtk.SizeGroupMode.VERTICAL});
    if (placementControls) controlHeights.add_widget(placementControls);
    const toolButtons = new Map();
    const activeTools = new Set();
    let syncingTools = false, toolsInitialized = false;
    let geometry = null, drag = null, settingsId = null, centreIdle = 0;
    let surface = null, surfaceId = null, placementClock = null, placementFrameId = null, placementWrapped = null;
    const queuePlacementCheck = () => {
        if (!placementControls || !box.get_mapped() || placementFrameId !== null) return;
        const clock = box.get_frame_clock(); if (!clock) return;
        placementClock = clock;
        placementFrameId = clock.connect('after-paint', () => {
            clock.disconnect(placementFrameId); placementFrameId = null; placementClock = null;
            if (!box.get_mapped()) return;
            const first = toolbar.get_allocation(), last = placementControls.get_allocation();
            const wrapped = last.y >= first.y + first.height;
            if (wrapped !== placementWrapped) {placementWrapped = wrapped; onPlacementWrapped?.(wrapped);}
        });
        box.queue_draw();
    };
    for (const [kind, [label, description]] of Object.entries(TOOLS)) {
        const button = new Gtk.ToggleButton({label, tooltip_text: `Show or hide ${label.toLowerCase()} nodes in the graph. ${description}`});
        controlHeights.add_widget(button);
        button.get_child().set_wrap(false);
        button.connect('toggled', () => {
            if (syncingTools) return;
            const visible = Object.keys(TOOLS).filter(name => toolButtons.get(name)?.get_active());
            applyTools(visible); settings.set_strv('magnification-visible-tools', visible);
        });
        toolButtons.set(kind, button); toolbar.append(button);
    }
    const viewbar = new Adw.WrapBox({name: 'magnification-view-controls', child_spacing: 16, line_spacing: 8,
        justify: Adw.JustifyMode.SPREAD, justify_last_line: true});
    if (previewControls) viewbar.append(previewControls);
    const zoomControls = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
    const zoomOut = new Gtk.Button({icon_name: 'zoom-out-symbolic', tooltip_text: 'Zoom out equally in both directions'});
    const zoomLabel = new Gtk.Label();
    const actualSize = new Gtk.Button({label: '1:1', tooltip_text: 'Actual size: one GNOME logical pixel per preview pixel'});
    const zoomIn = new Gtk.Button({icon_name: 'zoom-in-symbolic', tooltip_text: 'Zoom in equally in both directions'});
    for (const widget of [zoomOut, zoomLabel, zoomIn, actualSize]) zoomControls.append(widget);
    viewbar.append(zoomControls);
    const area = new Gtk.DrawingArea({hexpand: true, accessible_role: Gtk.AccessibleRole.IMG});
    area.update_property([Gtk.AccessibleProperty.LABEL], ['Magnification editor with actual app icon proportions. Toggle any combination of Size, Width, Shape, Spacing and Cutoff, then drag the highlighted handles.']);
    const scroller = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC, min_content_height: 180, max_content_height: 400,
        propagate_natural_height: true, child: area});
    scroller.add_css_class('view');
    const toolRow = new Adw.WrapBox({name: 'magnification-tool-row', child_spacing: 16, line_spacing: 20,
        justify: Adw.JustifyMode.SPREAD, justify_last_line: true});
    toolRow.append(toolbar);
    if (placementControls) toolRow.append(placementControls);
    for (const widget of [viewbar, scroller, toolRow]) {
        widget.set_margin_start(12); widget.set_margin_end(12); widget.set_margin_top(12); widget.set_margin_bottom(12);
        const row = new Adw.PreferencesRow({activatable: false, selectable: false}); row.set_child(widget); box.add(row);
    }
    const theme = Gtk.IconTheme.get_for_display(area.get_display());
    const images = ['org.gnome.Nautilus', 'org.gnome.Shell.Extensions', 'org.gnome.Settings', 'org.gnome.TextEditor'].map(name => {
        const file = theme.lookup_icon(name, null, 512, 1, Gtk.TextDirection.NONE, Gtk.IconLookupFlags.FORCE_REGULAR).get_file();
        try {return file ? GdkPixbuf.Pixbuf.new_from_file_at_scale(file.get_path(), 512, 512, true) : null;} catch {return null;}
    });
    const model = override => {
        const preset = sizePreset(settings.get_string('size-mode')), options = readMagnificationOptions(settings, preset);
        return magnificationGraphModel({...options, maxSize: peakIconSize(options, preset.iconSize), ...override},
            preset.iconSize, preset.iconSpacing, settings.get_int('magnification-example-count'));
    };
    const centreView = () => {
        if (centreIdle) return;
        centreIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            centreIdle = 0;
            const horizontal = scroller.get_hadjustment(), vertical = scroller.get_vadjustment();
            horizontal.set_value(Math.max(0, (horizontal.get_upper() - horizontal.get_page_size()) / 2));
            vertical.set_value(Math.max(0, vertical.get_upper() - vertical.get_page_size()));
            return GLib.SOURCE_REMOVE;
        });
    };
    const zoomValue = () => settings.get_int('magnification-graph-zoom') / 100;
    const setZoom = value => {settings.set_int('magnification-graph-zoom', Math.round(Math.max(5, Math.min(200, value)))); centreView();};
    zoomOut.connect('clicked', () => setZoom(settings.get_int('magnification-graph-zoom') / 1.25));
    zoomIn.connect('clicked', () => setZoom(settings.get_int('magnification-graph-zoom') * 1.25));
    actualSize.connect('clicked', () => setZoom(100));
    const update = () => {
        const current = model(), zoom = zoomValue();
        const extent = Math.max(144, current.cutoffEnabled ? current.cutoffX : 0, activeTools.has('compression') ? current.reachX : 0,
            activeTools.has('shape') ? current.shoulder.x : 0, ...current.markers.map(point => Math.abs(point.x) + point.width / 2));
        const view = magnificationGraphViewport(current, 0, 0, zoom);
        area.set_size_request(drag?.geometry.width ?? Math.ceil(72 + extent * 2 * zoom),
            drag?.geometry.height ?? Math.ceil(view.contentHeight));
        zoomLabel.set_label(`${Math.round(zoom * 100)}%`);
        area.queue_draw();
        queuePlacementCheck();
    };
    const applyTools = visible => {
        const selected = Object.keys(TOOLS).filter(name => visible.includes(name));
        if (toolsInitialized && selected.length === activeTools.size && selected.every(name => activeTools.has(name))) return;
        toolsInitialized = true; activeTools.clear(); selected.forEach(name => activeTools.add(name));
        syncingTools = true;
        for (const [name, button] of toolButtons) button.set_active(activeTools.has(name));
        syncingTools = false;
        if (drag && !activeTools.has(drag.kind)) drag = null;
        update();
    };
    box.connect('realize', () => {
        surface = box.get_root().get_surface(); surfaceId = surface.connect('layout', queuePlacementCheck);
        settingsId = settings.connect('changed', (_settings, key) => {
            if (key === 'magnification-visible-tools') applyTools(settings.get_strv(key)); else update();
        });
        applyTools(settings.get_strv('magnification-visible-tools')); update(); centreView();
    });
    box.connect('map', queuePlacementCheck);
    box.connect('unrealize', () => {
        if (settingsId !== null) settings.disconnect(settingsId); settingsId = null;
        if (centreIdle) GLib.Source.remove(centreIdle); centreIdle = 0;
        if (surfaceId !== null) surface.disconnect(surfaceId); surface = null; surfaceId = null;
        if (placementFrameId !== null) placementClock.disconnect(placementFrameId); placementClock = null; placementFrameId = null;
    });
    let lastWidth = 0, lastHeight = 0;
    area.set_draw_func((_widget, ctx, width, height) => {
        const current = model(), fg = area.get_color(), zoom = zoomValue();
        const view = magnificationGraphViewport(current, width, height, zoom);
        const {px, py, physicalY, baseline, floor, centre, left, right, top} = view;
        if (width !== lastWidth || height !== lastHeight) {lastWidth = width; lastHeight = height; centreView();}
        const [hasAccent, color] = area.get_style_context().lookup_color('accent_color');
        const accent = hasAccent ? [color.red, color.green, color.blue] : [0.2, 0.55, 0.95];
        const ink = (alpha = 1) => ctx.setSourceRGBA(fg.red, fg.green, fg.blue, alpha);
        const highlight = (alpha = 1) => ctx.setSourceRGBA(...accent, alpha);
        const text = (label, x, y, alpha = 0.65) => {ink(alpha); ctx.moveTo(x, y); ctx.showText(label);};
        ctx.selectFontFace('Sans', 0, 0); ctx.setFontSize(11);
        const plotTop = Math.max(top, py(current.peak) - 20), plotBottom = floor + 2;
        if (current.cutoffEnabled) {
            ink(0.06); ctx.rectangle(left, plotTop, Math.max(0, px(-current.cutoffX) - left), plotBottom - plotTop); ctx.fill();
            ctx.rectangle(px(current.cutoffX), plotTop, Math.max(0, right - px(current.cutoffX)), plotBottom - plotTop); ctx.fill();
        }
        for (let value = 1; value <= Math.floor((floor - plotTop) / (current.normalSize * zoom)); value++) {
            const y = floor - current.normalSize * value * zoom;
            ink(value === 1 ? 0.5 : 0.12); ctx.setLineWidth(1); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
            text(`${value}×`, 14, y + 4);
        }
        ink(0.25); ctx.moveTo(centre, plotTop); ctx.lineTo(centre, plotBottom); ctx.stroke();
        text('cursor', centre - 17, plotTop - 9);
        const tick = zoom < 0.6 ? 100 : 50;
        for (let value = -Math.floor((centre - left) / zoom / tick) * tick; value <= (right - centre) / zoom; value += tick)
            text(String(value), px(value) - 7, floor + 25, 0.45);
        text('Physical position from cursor · logical pixels', left, height - 9);
        const drawCurve = (topAt, alpha, dashed) => {
            highlight(alpha); ctx.setLineWidth(dashed ? 1 : 2); ctx.setDash(dashed ? [4, 4] : [], 0); ctx.newPath();
            for (let x = left; x <= right; x += 1) {
                const y = physicalY(topAt((x - centre) / zoom));
                if (x === left) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke(); ctx.setDash([], 0);
        };
        drawCurve(current.bareTopAt, 0.2, true);
        for (const point of current.markers) {
            const image = images[point.index % images.length];
            ctx.save(); ctx.translate(px(point.x) - point.width * zoom / 2, physicalY(point.top));
            if (image) {
                const fitScale = Math.min(point.width * zoom / image.width, point.height * zoom / image.height);
                ctx.translate((point.width * zoom - image.width * fitScale) / 2, (point.height * zoom - image.height * fitScale) / 2);
                ctx.scale(fitScale, fitScale);
                Gdk.cairo_set_source_pixbuf(ctx, image, 0, 0); ctx.paintWithAlpha(0.85);
            } else {highlight(0.6); ctx.rectangle(0, 0, point.width * zoom, point.height * zoom); ctx.fill();}
            ctx.restore();
        }
        drawCurve(current.topAt, 0.9, false);
        const handles = [];
        const circle = (x, y, radius, fill = true) => {ctx.newPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); if (fill) ctx.fill(); else ctx.stroke();};
        if (activeTools.has('marker')) for (const point of current.markers) {
            if (Math.abs(point.source) < 0.01 || current.cutoffEnabled && Math.abs(point.sampleX) >= settings.get_int('magnification-cutoff-distance')) continue;
            highlight(); circle(px(point.x), physicalY(point.top), 6);
            handles.push({kind: 'marker', x: px(point.x), y: physicalY(point.top), point,
                bounds: {x: px(point.x) - point.width * zoom / 2, y: physicalY(point.top), width: point.width * zoom, height: point.height * zoom}});
        }
        if (activeTools.has('cutoff') && current.cutoffEnabled) for (const sign of [-1, 1]) {
            const x = px(sign * current.cutoffX), y = floor + 9;
            highlight(0.7); ctx.setDash([4, 4], 0); ctx.moveTo(x, plotTop); ctx.lineTo(x, floor); ctx.stroke(); ctx.setDash([], 0);
            highlight(); ctx.moveTo(x, y - 6); ctx.lineTo(x - 7, y + 5); ctx.lineTo(x + 7, y + 5); ctx.closePath(); ctx.fill();
            text('Cutoff', x + sign * 8 - (sign < 0 ? 34 : 0), plotTop + 14);
            handles.push({kind: 'cutoff', x, y, sign});
        }
        if (activeTools.has('compression')) for (const sign of [-1, 1]) {
            const x = px(sign * current.reachX), y = floor + 9;
            highlight(); ctx.rectangle(x - 6, y - 6, 12, 12); ctx.fill();
            handles.push({kind: 'compression', x, y, sign});
        }
        if (activeTools.has('shape') && current.shoulder.y > 1.001) for (const sign of [-1, 1]) {
            const x = px(sign * current.shoulder.x), y = py(current.shoulder.y);
            highlight(); circle(x, y, 7, false); handles.push({kind: 'shape', x, y});
        }
        if (activeTools.has('peak')) {
            highlight(); circle(centre, py(current.peak), 7);
            handles.push({kind: 'peak', x: centre, y: py(current.peak)});
        }
        geometry = {...view, model: current, handles, width, height};
    });
    const handleAt = (x, y) => geometry?.handles.filter(item => Math.hypot(x - item.x, y - item.y) <= 15
        || item.bounds && x >= item.bounds.x && x <= item.bounds.x + item.bounds.width && y >= item.bounds.y && y <= item.bounds.y + item.bounds.height)
        .sort((a, b) => Math.hypot(x - a.x, y - a.y) - Math.hypot(x - b.x, y - b.y))[0];
    const motion = new Gtk.EventControllerMotion();
    motion.connect('motion', (_controller, x, y) => {
        const handle = handleAt(x, y);
        area.set_cursor_from_name(!handle ? 'default' : ['peak', 'shape'].includes(handle.kind) ? 'ns-resize' : 'ew-resize');
    });
    motion.connect('leave', () => area.set_cursor_from_name('default')); area.add_controller(motion);
    const gesture = new Gtk.GestureDrag({button: 1});
    gesture.connect('drag-begin', (_gesture, x, y) => {
        const handle = handleAt(x, y); if (!handle) return;
        const preset = sizePreset(settings.get_string('size-mode'));
        drag = {...handle, geometry: {...geometry, model: model()}, preset, x, y, compression: settings.get_int('magnification-compression'),
            shape: settings.get_int('magnification-sharpness'),
            gap: settings.get_boolean('magnification-preset-app-gap') ? preset.iconSpacing : settings.get_int('magnification-app-gap')};
        gesture.set_state(Gtk.EventSequenceState.CLAIMED);
    });
    const solve = (target, low, high, coordinate) => {
        const ascending = coordinate(high) >= coordinate(low);
        for (let i = 0; i < 12; i++) {
            const middle = (low + high) / 2;
            if ((coordinate(middle) < target) === ascending) low = middle; else high = middle;
        }
        return (low + high) / 2;
    };
    const integer = (name, value, min, max) => settings.set_int(`magnification-${name}`, Math.round(Math.max(min, Math.min(max, value))));
    gesture.connect('drag-update', (_gesture, dx, dy) => {
        if (!drag) return; const g = drag.geometry;
        if (drag.kind === 'peak') {
            const scale = g.model.peak - dy / g.unitY;
            if (settings.get_string('magnification-peak-mode') === 'pixels') integer('peak-pixels', scale * drag.preset.iconSize, 1, 512);
            else integer('scale', scale * 100, 100, 500);
        } else if (drag.kind === 'shape') integer('sharpness', drag.shape * Math.exp(dy / 60), 25, 400);
        else if (drag.kind === 'compression') {
            const target = Math.max(0, (drag.x + dx - g.centre) * drag.sign) / g.zoom;
            integer('compression', solve(target, 5, 1600, value => model({compression: value / 100}).reachX), 5, 1600);
        } else if (drag.kind === 'cutoff') {
            const target = Math.max(0, (drag.x + dx - g.centre) * drag.sign) / g.zoom;
            integer('cutoff-distance', solve(target, 0, 2048, value => model({cutoffDistance: value}).cutoffX), 0, 2048);
        } else if (drag.kind === 'marker') {
            const index = drag.point.index, sign = Math.sign(g.model.markers[index].x);
            const target = Math.max(0, (g.model.markers[index].x + dx / g.zoom) * sign);
            const gap = solve(target, 0, 64, value => Math.abs(model({iconGap: value}).markers[index].x));
            settings.set_boolean('magnification-preset-app-gap', false); integer('app-gap', gap, 0, 64);
        }
    });
    gesture.connect('drag-end', () => {drag = null; update();});
    gesture.connect('cancel', () => {drag = null; update();}); area.add_controller(gesture);
    applyTools(settings.get_strv('magnification-visible-tools')); update();
    return box;
}
