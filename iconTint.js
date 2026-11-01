// Sample the icon asset, never the screen. Ignore transparent padding and favour
// its dominant colour over neutral borders, highlights and drop shadows.
export function dominantIconTint(pixels, width, height, rowstride, channels) {
    const palette = new Map(), hues = new Map();
    let coverage = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const offset = y * rowstride + x * channels;
        const alpha = channels === 4 ? pixels[offset + 3] / 255 : 1;
        if (alpha < 0.15) continue;
        const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2];
        const maximum = Math.max(red, green, blue), minimum = Math.min(red, green, blue);
        const saturation = maximum ? (maximum - minimum) / maximum : 0;
        coverage += alpha;
        // Textured icons spread their accent across many RGB buckets, while
        // black screens and grey borders concentrate in just one. Group the
        // coloured pixels by hue so the screen's blue can win as a family.
        if (saturation >= 0.25 && maximum - minimum >= 24) {
            const chroma = maximum - minimum;
            let hue = maximum === red ? (green - blue) / chroma
                : maximum === green ? 2 + (blue - red) / chroma : 4 + (red - green) / chroma;
            hue = (hue + 6) % 6;
            const key = Math.round(hue * 4) % 24;
            const weight = alpha * saturation * chroma / 255;
            const family = hues.get(key) ?? {weight: 0, coverage: 0, red: 0, green: 0, blue: 0};
            family.coverage += alpha; family.weight += weight;
            family.red += red * weight; family.green += green * weight; family.blue += blue * weight;
            hues.set(key, family);
        }
        const weight = alpha * (0.15 + saturation * saturation);
        const key = (red >> 5) << 6 | (green >> 5) << 3 | blue >> 5;
        const bucket = palette.get(key) ?? {weight: 0, red: 0, green: 0, blue: 0};
        bucket.weight += weight;
        bucket.red += red * weight; bucket.green += green * weight; bucket.blue += blue * weight;
        palette.set(key, bucket);
    }
    const accent = [...hues.values()].filter(family => family.coverage >= coverage * 0.02)
        .sort((a, b) => b.weight - a.weight)[0];
    const dominant = accent ?? [...palette.values()].sort((a, b) => b.weight - a.weight)[0];
    if (!dominant) return null;
    return Object.fromEntries(['red', 'green', 'blue'].map(channel => [channel, Math.round(dominant[channel] / dominant.weight)]));
}

export function visibleIconBounds(pixels, width, height, rowstride, channels) {
    let left = width, top = height, right = 0, bottom = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        // Ignore the barely visible fringe of the asset's own baked-in shadow.
        if (channels === 4 && pixels[y * rowstride + x * channels + 3] < 24) continue;
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
    return right > left && bottom > top
        ? {x: left, y: top, width: right - left, height: bottom - top, canvasWidth: width, canvasHeight: height}
        : null;
}

export function focusShadowGeometry(target, bounds, monitor, options = {}) {
    const ink = bounds ?? {x: 0, y: 0, width: 1, height: 1, canvasWidth: 1, canvasHeight: 1};
    const scale = Math.min(target.width / ink.canvasWidth, target.height / ink.canvasHeight);
    const inkBottom = target.y + (target.height - ink.canvasHeight * scale) / 2 + (ink.y + ink.height) * scale;
    const width = Math.max(18, target.width * 1.2) * (options.focusHighlightWidth ?? 1);
    const height = Math.max(10, target.height * 0.3) * (options.focusHighlightHeight ?? 1);
    // Keep the brightest point just BELOW the visible icon. Clipping a soft tail
    // at the screen edge is preferable to pushing the glow back behind the icon.
    const centreY = Math.min(inkBottom + Math.max(1, ink.height * scale * 0.05) + (options.focusHighlightOffset ?? 0), monitor.y + monitor.height - 0.5);
    return {x: target.x + (target.width - width) / 2, y: centreY - height / 2, width, height};
}

export function focusHighlightStops(options = {}) {
    const opacity = Math.max(0, Math.min(1, options.focusHighlightOpacity ?? 0.8));
    const softness = Math.max(0, Math.min(1, options.focusHighlightSoftness ?? 1));
    if (!softness) return [[0, opacity], [1, opacity]];
    const edge = 1 - softness;
    return [[0, opacity], [edge, opacity], [edge + 0.35 * softness, opacity * 0.625],
        [edge + 0.7 * softness, opacity * 0.2], [1, 0]];
}

export function focusHighlightColor(iconTint, accent, options = {}) {
    const parse = value => {
        const match = /^#([0-9a-f]{6})$/i.exec(value ?? '');
        return match ? {red: parseInt(match[1].slice(0, 2), 16), green: parseInt(match[1].slice(2, 4), 16), blue: parseInt(match[1].slice(4, 6), 16)} : null;
    };
    if (options.focusHighlightColorMode === 'custom') return parse(options.focusHighlightColor) ?? parse('#3584e4');
    if (options.focusHighlightColorMode === 'accent') return parse(accent) ?? iconTint;
    return iconTint;
}
