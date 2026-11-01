import {DEFAULT_CONFIGURATION} from './defaultConfiguration.js';
// Shared by the shell and preferences so every tuning control has one definition.
const integer = (section, name, title, subtitle, value, min, max, step = 1, extra = {}) =>
    ({section, key: `magnification-${name}`, type: 'i', title, subtitle,
        default: value, min, max, step, ...extra});
const toggle = (section, name, title, subtitle, value = true, extra = {}) =>
    ({section, key: `magnification-${name}`, type: 'b', title, subtitle, default: value, ...extra});
const choice = (section, name, title, subtitle, value, values, labels, extra = {}) =>
    ({section, key: `magnification-${name}`, type: 's', title, subtitle, default: value, values, labels, ...extra});

export const LIFT_MAX_UNITS = 2;
export const snapLiftUnits = value => Math.max(0, Math.min(LIFT_MAX_UNITS, Math.round(value * 2) / 2));
export const liftUnitsForPixels = (pixels, normalSize) => snapLiftUnits(pixels / normalSize);
export const liftPixelsForUnits = (units, normalSize) => Math.round(snapLiftUnits(units) * normalSize);

export const MAGNIFICATION_SECTIONS = {
    size: ['Size and Curve', 'Control how large items grow and how widely the effect spreads.'],
    spacing: ['Spacing and Alignment', 'Control the space around items and their position above or below the panel.'],
    circle: ['Active Workspace Circle', 'Fine-tune the circle drawn in your GNOME accent colour.'],
    highlight: ['Focused App Highlight', 'Configure the coloured shadow beneath the focused app icon while magnified.'],
    style: ['Animation and Appearance', 'Control transitions, icon and number opacity, and shadows.'],
};

export const MAGNIFICATION_ADVANCED = [
    integer('size', 'scale', 'Peak Size', 'Largest app icon size, as a percentage of normal size or in pixels. 100% keeps the normal size.', 250, 100, 500, 10, {rebuild: true, basic: true}),
    choice('size', 'peak-mode', 'Peak Size Units', 'Choose a size relative to the normal icon or an absolute pixel size.', 'relative', ['relative', 'pixels'], ['Percent', 'Pixels'], {rebuild: true}),
    integer('size', 'peak-pixels', 'Peak Pixel Size', 'Absolute peak size; icons never shrink below their normal size.', 50, 1, 512, 1, {rebuild: true}),
    integer('size', 'compression', 'Horizontal Compression c', 'c in f(cx): 1 keeps the base width; larger values narrow the bell and smaller values widen it. The pixel coordinate system stays fixed.', 100, 5, 1600, 5, {basic: true}),
    toggle('size', 'cutoff-enabled', 'Enable Cutoff', 'Return to normal size and spacing beyond the cutoff distance. Turn off to let the full curve continue without a boundary.', true, {basic: true}),
    integer('size', 'cutoff-distance', 'Cutoff Distance', 'Distance on each side of the cursor in GNOME logical pixels. Beyond it, app scale and spacing are exactly normal. Independent of compression c.', 96, 0, 2048, 1, {basic: true}),
    integer('size', 'graph-zoom', 'Graph Zoom', '100% displays the real logical-pixel size. Zoom always scales both axes and icon dimensions together.', 100, 5, 200, 5, {basic: true, uiOnly: true}),
    integer('size', 'graph-span', 'Graph View', 'Pixel distance shown on each side of the graph. This zooms only the editor; it never changes magnification.', 192, 32, 4096, 16, {basic: true}),
    integer('size', 'sharpness', 'Curve Shape', '100% gives a Gaussian bell. Higher values make the centre more pointed with longer tails; lower values flatten the centre and steepen the shoulders.', 100, 25, 400, 5),
    integer('size', 'cutoff-softness', 'Cutoff Transition', 'Fade to normal inside the cutoff boundary. 0% makes an immediate piecewise cutoff; the shaded region always stays normal.', 0, 0, 50, 1),
    toggle('size', 'adaptive-reach', 'Adapt Width to Icon Count', 'Enable explicit app-count-dependent compression. Fixed mode keeps c independent of app count.', false, {basic: true}),
    choice('size', 'reach-response', 'Width Response', 'Fewer Icons narrows below the reference count. More Icons narrows above it, keeping a crowded bar compact.', 'fewer', ['fewer', 'more'], ['Fewer Icons', 'More Icons'], {basic: true}),
    integer('size', 'reach-reference', 'Reference Icon Count', 'Shown app count at which the curve uses its configured width. The selected width mode determines which side of this count narrows the curve.', 8, 1, 32, 1, {depends: ['magnification-adaptive-reach', true]}),
    integer('size', 'example-count', 'Example Icon Count', 'Number of apps in the graph. This previews dynamic compression; the live bar uses its actual shown app count.', 9, 1, 31, 1, {basic: true}),
    toggle('size', 'app-only', 'Ignore Workspace Numbers in the Curve', 'Treat numbers and workspace separators as one normal app gap when calculating app sizes. Turn off to use their full on-screen distance.'),
    choice('size', 'number-mode', 'When Numbers Grow', 'Follow Icon matches the nearest app. Own Workspace grows numbers only over their own workspace. Normal Size removes growth. Numbers stay vertically aligned with their nearest app in every mode.', 'follow-app', ['follow-app', 'own-workspace', 'none'], ['Follow Icon', 'Own Workspace', 'Normal Size']),
    integer('size', 'number-scale', 'Number Growth', 'Percentage of the extra growth applied to numbers. 100% follows the usual growth; 0% removes growth without changing app icons.', 100, 0, 200, 5),
    toggle('size', 'empty-numbers', 'Magnify Empty Workspace Numbers', 'Let a number grow even when its workspace has no app icons to follow.'),
    toggle('size', 'empty-hover-only', 'Empty Numbers Grow Only on Hover', 'Keep neighbouring empty numbers at normal size. Turn off to let the curve affect them from nearby.', true, {depends: ['magnification-empty-numbers', true]}),

    choice('spacing', 'spacing-mode', 'Marker Spacing', 'Uniform uses the custom app gap throughout the affected region. Bell Curve follows magnification. Diminishing reduces extra spacing toward the cutoff.', 'curve', ['uniform', 'curve', 'diminishing'], ['Uniform', 'Bell Curve', 'Diminishing'], {basic: true}),
    integer('spacing', 'spacing-falloff', 'Spacing Falloff', 'How quickly diminishing extra spacing falls toward the normal gap. Higher values concentrate spacing near the cursor.', 100, 25, 400, 5),
    toggle('spacing', 'preset-app-gap', 'Use Preset App Icon Spacing', 'Keep app-to-app gaps from the normal size preset. Turn off to use the custom gap below.'),
    integer('spacing', 'app-gap', 'App Icon Gap', 'Automatic keeps normal app gaps. Custom sets the gap in pixels; Marker Spacing controls its distribution inside the cutoff. Moving markers changes where apps sample the curve. The curve itself stays fixed.', 6, 0, 64, 1, {depends: ['magnification-preset-app-gap', false]}),
    toggle('spacing', 'preset-number-gap', 'Use Preset Number-to-Icon Spacing', 'Keep the automatic gap from a visible digit or circle to its own icons. Turn off to set a custom gap.'),
    integer('spacing', 'number-gap', 'Number-to-Icon Gap', 'Gap from the visible digit or circle to its own app group near the cursor, in pixels. Does not change workspace-to-workspace spacing.', 6, 0, 64, 1, {depends: ['magnification-preset-number-gap', false]}),
    toggle('spacing', 'preset-group-minimum', 'Use Preset Minimum Workspace Gap', 'Keep a small size-preset gutter between neighbouring workspace groups, even when Workspace Group Gap is zero.'),
    integer('spacing', 'group-minimum', 'Minimum Workspace Gap', 'Smallest allowed gap between workspace groups near the cursor, in pixels. Zero allows groups to touch.', 6, 0, 64, 1, {depends: ['magnification-preset-group-minimum', false]}),
    toggle('spacing', 'trim-number-padding', 'Trim Transparent Number Padding', 'Pack numbers using the visible digit or circle. Turn off to reserve the full original number cell, leaving more space around numbers.'),
    integer('spacing', 'number-padding', 'Extra Number Padding', 'Extra margin reserved around a magnified digit or circle, in normal-size pixels. This margin grows with the number.', 0, 0, 24, 1, {depends: ['magnification-trim-number-padding', true]}),
    choice('spacing', 'vertical-alignment', 'Vertical Alignment', 'Dock Curve keeps icons anchored to the panel edge. Centre Line puts the centres of all magnified items on one horizontal line.', 'panel-edge', ['panel-edge', 'center-line'], ['Dock Curve', 'Centre Line']),
    integer('spacing', 'lift', 'Lift from Panel', 'Each +1 raises the icons by one normal icon height. Snaps to half steps, up to +2.', 0, 0, 128, 1),
    integer('spacing', 'number-offset', 'Number Vertical Offset', 'Move only workspace numbers relative to their icons. Positive values move into the desktop; negative values move back toward the panel.', 0, -64, 64, 1),

    integer('circle', 'circle-padding', 'Circle Inset', 'Inset from the number cell on each side, in pixels. A larger value makes the active circle smaller.', 4, 0, 20, 1, {rebuild: true}),
    integer('circle', 'circle-width', 'Circle Border Width', 'Thickness of the accent-coloured circle, in pixels before magnification.', 2, 1, 8, 1, {css: true, rebuild: true}),
    integer('circle', 'circle-opacity', 'Circle Opacity', 'Visibility of the active circle, from 0% transparent to 100% opaque.', 100, 0, 100, 5),
    integer('circle', 'optical-strength', 'Optical Centring Strength', 'Compensate for uneven visual weight in digits such as 4. 100% is the normal correction; 0% uses the digit bounding box.', 100, 0, 200, 5),
    integer('circle', 'circle-offset-x', 'Circle Horizontal Offset', 'Move the circle relative to its digit, in pixels before magnification. Positive values move right; negative values move left.', 0, -24, 24, 1),
    integer('circle', 'circle-offset-y', 'Circle Vertical Offset', 'Move the circle relative to its digit, in pixels before magnification. Positive values move down; negative values move up.', 0, -24, 24, 1),

    toggle('highlight', 'focus-highlight-enabled', 'Enable Highlight', 'Mark the focused window with a coloured glow beneath its magnified app icon.'),
    integer('highlight', 'focus-highlight-opacity', 'Highlight Opacity', 'Visibility of the focused app highlight. 0% hides it; 100% makes the centre fully opaque.', 80, 0, 100, 5, {depends: ['magnification-focus-highlight-enabled', true]}),
    integer('highlight', 'focus-highlight-softness', 'Highlight Softness', '100% uses the original soft fade. Lower values sharpen the edge; 0% draws a solid ellipse.', 100, 0, 100, 5, {depends: ['magnification-focus-highlight-enabled', true]}),
    integer('highlight', 'focus-highlight-width', 'Highlight Width', 'Stretch or narrow the glow horizontally. 100% keeps its original width; it scales with the app icon.', 100, 25, 300, 5, {depends: ['magnification-focus-highlight-enabled', true]}),
    integer('highlight', 'focus-highlight-height', 'Highlight Height', 'Stretch or flatten the glow vertically. 100% keeps its original height; it scales with the app icon.', 100, 25, 300, 5, {depends: ['magnification-focus-highlight-enabled', true]}),
    integer('highlight', 'focus-highlight-offset', 'Highlight Vertical Offset', 'Extra distance from the icon’s lowest visible pixel, in logical pixels. Positive moves down; negative moves up. The screen edge limits downward movement.', 0, -32, 64, 1, {depends: ['magnification-focus-highlight-enabled', true]}),
    choice('highlight', 'focus-highlight-color-mode', 'Highlight Colour', 'App Icon adapts low-contrast tints for visibility. Accent Colour and Custom keep your chosen colour.', 'icon', ['icon', 'accent', 'custom'], ['App Icon', 'Accent Colour', 'Custom'], {depends: ['magnification-focus-highlight-enabled', true]}),
    {section: 'highlight', key: 'magnification-focus-highlight-color', type: 'color', title: 'Custom Highlight Colour',
        subtitle: 'Choose the colour used when Highlight Colour is set to Custom.', default: '#3584e4', depends: ['magnification-focus-highlight-enabled', true]},

    integer('style', 'duration', 'Transition Duration', 'Time in milliseconds for hover entry, exit, empty-number growth and circle spacing changes. Zero makes transitions immediate.', 180, 0, 1000, 10, {css: true}),
    choice('style', 'easing', 'Transition Easing', 'Ease Out starts quickly and settles gently. Ease In and Out softens both ends. Linear changes at a constant speed.', 'ease-out', ['ease-out', 'ease-in-out', 'linear'], ['Ease Out', 'Ease In and Out', 'Linear']),
    integer('style', 'icon-opacity', 'App Icon Opacity', 'Visibility of magnified app icons, from 0% transparent to 100% opaque.', 100, 0, 100, 5),
    integer('style', 'number-opacity', 'Workspace Number Opacity', 'Visibility of magnified numbers and their circles, from 0% transparent to 100% opaque.', 100, 0, 100, 5),
    integer('style', 'icon-shadow-opacity', 'Icon Shadow Opacity', 'Darkness of the shadow behind magnified app icons. Set to 0% to remove the shadow.', 40, 0, 100, 5, {css: true}),
    integer('style', 'icon-shadow-blur', 'Icon Shadow Blur', 'Softness of the app icon shadow, in pixels. Zero produces a sharp shadow.', 8, 0, 32, 1, {css: true}),
    integer('style', 'icon-shadow-offset', 'Icon Shadow Offset', 'Vertical distance of the app icon shadow below the icon, in pixels.', 3, 0, 16, 1, {css: true}),
    integer('style', 'number-shadow-opacity', 'Number Shadow Opacity', 'Darkness of the shadow behind magnified digits. Set to 0% to remove the shadow.', 50, 0, 100, 5, {css: true}),
    integer('style', 'number-shadow-blur', 'Number Shadow Blur', 'Softness of the number shadow, in pixels. Zero produces a sharp shadow.', 6, 0, 32, 1, {css: true}),
    integer('style', 'number-shadow-offset', 'Number Shadow Offset', 'Vertical distance of the number shadow below the digit, in pixels.', 2, 0, 16, 1, {css: true}),
    integer('style', 'drag-delay', 'Drag Hold Delay', 'How long to hold a magnified item before dragging begins and the normal workspace bar returns, in milliseconds.', 400, 100, 1500, 50, {rebuild: true}),
].map(option => ({...option, default: DEFAULT_CONFIGURATION[option.key] ?? option.default}));

// Legacy floor is retained for migration, but is no longer an independent size control.
export const MAGNIFICATION_KEYS = ['enable-magnification', 'magnification-spacing', 'magnification-minimum-peak-size', 'magnification-reach', 'magnification-cutoff',
    'show-active-workspace-ring', 'magnification-frame-opacity', ...MAGNIFICATION_ADVANCED.map(setting => setting.key)];

export function readMagnificationOptions(settings, preset) {
    const i = name => settings.get_int(`magnification-${name}`);
    const b = name => settings.get_boolean(`magnification-${name}`);
    return {
        enabled: settings.get_boolean('enable-magnification'),
        scale: i('scale') / 100, peakMode: settings.get_string('magnification-peak-mode'), peakPixels: i('peak-pixels'),
        compression: i('compression') / 100, cutoffEnabled: b('cutoff-enabled'), cutoffDistance: i('cutoff-distance'), graphSpan: i('graph-span'), cutoffSoftness: i('cutoff-softness') / 100,
        adaptiveReach: b('adaptive-reach'), reachReference: i('reach-reference'), reachResponse: settings.get_string('magnification-reach-response'),
        spacingMode: settings.get_string('magnification-spacing-mode'), spacingFalloff: i('spacing-falloff') / 100,
        sharpness: i('sharpness') / 100, appOnly: b('app-only'),
        numberMode: settings.get_string('magnification-number-mode'), numberScale: i('number-scale') / 100,
        magnifyEmpty: b('empty-numbers'), emptyHoverOnly: b('empty-hover-only'),
        iconGap: b('preset-app-gap') ? undefined : i('app-gap'),
        numberGap: b('preset-number-gap') ? preset.iconSpacing : i('number-gap'),
        minimumGroupSpacing: b('preset-group-minimum') ? preset.iconSpacing : i('group-minimum'),
        trimNumbers: b('trim-number-padding'), numberPadding: i('number-padding'),
        verticalAlignment: settings.get_string('magnification-vertical-alignment'),
        lift: i('lift'), numberOffset: i('number-offset'),
        circlePadding: i('circle-padding'), circleWidth: i('circle-width'), circleOpacity: i('circle-opacity') / 100,
        opticalStrength: i('optical-strength') / 100, circleOffsetX: i('circle-offset-x'), circleOffsetY: i('circle-offset-y'),
        duration: i('duration'), easing: settings.get_string('magnification-easing'), frameOpacity: 0,
        iconOpacity: i('icon-opacity') / 100, numberOpacity: i('number-opacity') / 100,
        iconShadowOpacity: i('icon-shadow-opacity') / 100, iconShadowBlur: i('icon-shadow-blur'), iconShadowOffset: i('icon-shadow-offset'),
        numberShadowOpacity: i('number-shadow-opacity') / 100, numberShadowBlur: i('number-shadow-blur'), numberShadowOffset: i('number-shadow-offset'),
        dragDelay: i('drag-delay'),
        ...readFocusHighlightOptions(settings),
    };
}

export function readFocusHighlightOptions(settings) {
    const i = name => settings.get_int(`magnification-focus-highlight-${name}`);
    return {
        focusHighlightEnabled: settings.get_boolean('magnification-focus-highlight-enabled'),
        focusHighlightOpacity: i('opacity') / 100, focusHighlightSoftness: i('softness') / 100,
        focusHighlightWidth: i('width') / 100, focusHighlightHeight: i('height') / 100, focusHighlightOffset: i('offset'),
        focusHighlightColorMode: settings.get_string('magnification-focus-highlight-color-mode'),
        focusHighlightColor: settings.get_string('magnification-focus-highlight-color'),
    };
}

export function easeMagnification(progress, mode = 'ease-out') {
    if (mode === 'linear') return progress;
    if (mode === 'ease-in-out') return progress * progress * (3 - 2 * progress);
    return 1 - (1 - progress) ** 3;
}

// Migrate once, keeping the effective peak size of existing installations.
// Calling from either preferences or the shell is safe and idempotent.
export function migrateMagnificationSettings(settings, preset) {
    // Frames always disappear in the magnified view; discard the old tuning value.
    if (settings.get_int('magnification-frame-opacity') > 0) settings.set_int('magnification-frame-opacity', 0);
    const version = settings.get_int('magnification-settings-version');
    if (version >= 2) return;
    const relative = Math.round(preset.iconSize * settings.get_int('magnification-scale') / 100);
    const floor = settings.get_int('magnification-minimum-peak-size');
    if (version < 1 && floor > relative) {
        settings.set_int('magnification-peak-pixels', floor);
        settings.set_string('magnification-peak-mode', 'pixels');
    }
    if (settings.get_user_value?.('magnification-reach') || settings.get_user_value?.('magnification-cutoff')) {
        const radius = preset.iconSize * settings.get_int('magnification-reach') / 100;
        settings.set_int('magnification-compression', Math.max(5, Math.min(1600, Math.round(6400 / radius))));
        settings.set_int('magnification-cutoff-distance', Math.round(radius * settings.get_int('magnification-cutoff') / 100));
    }
    settings.set_int('magnification-settings-version', 2);
}

export function peakIconSize(options, normalSize) {
    return Math.max(normalSize, Math.round(options.peakMode === 'pixels'
        ? options.peakPixels : normalSize * options.scale));
}

export const SIZE_PRESETS = {
    small:  { iconSize: 16, fontSize: 12, numSpacing: 5, btnSpacing: 4, vertSpacing: 3, roundness: 6, borderWidth: 2, iconSpacing: 3, wrapperSpacing: 4 },
    medium: { iconSize: 20, fontSize: 15, numSpacing: 7, btnSpacing: 6, vertSpacing: 4, roundness: 8, borderWidth: 2, iconSpacing: 5, wrapperSpacing: 5 },
    large:  { iconSize: 26, fontSize: 19, numSpacing: 9, btnSpacing: 8, vertSpacing: 5, roundness: 10, borderWidth: 2, iconSpacing: 6, wrapperSpacing: 6 },
};

export function sizePreset(mode) {
    return SIZE_PRESETS[mode] ?? SIZE_PRESETS.medium;
}
