// x is signed app-sampling distance in GNOME logical screen pixels.
// The base bell is defined for every real x; compression c applies f(c*x).
export const BASE_HALF_WIDTH = 32;
export function effectiveCompression(compression = 1, count = 1, adaptive = false, reference = 8, response = 'fewer') {
    if (!adaptive) return compression;
    const ratio = Math.max(1, count) / Math.max(1, reference);
    return compression / Math.min(1, response === 'more' ? 1 / ratio : ratio);
}
export function bellWeight(x, compression = 1, shape = 1) {
    return Math.exp(-Math.LN2 * (Math.abs(x) * compression / BASE_HALF_WIDTH) ** (1 + 1 / shape));
}
export function cutoffGate(x, distance, softness = 0, enabled = true) {
    if (!enabled) return 1;
    const remaining = distance - Math.abs(x);
    if (remaining <= 0) return 0;
    const t = softness > 0 ? Math.min(1, remaining / (distance * softness)) : 1;
    return t * t * (3 - 2 * t);
}
export function curveWeight(x, options) {
    return bellWeight(x, options.compression, options.sharpness) * cutoffGate(x, options.cutoffDistance, options.cutoffSoftness, options.cutoffEnabled);
}
export function curveSpacingWeight(x, options) {
    const gate = cutoffGate(x, options.cutoffDistance, options.cutoffSoftness, options.cutoffEnabled);
    if (!gate) return 0;
    if (options.spacingMode === 'uniform') return gate;
    if (options.spacingMode === 'diminishing') {
        if (options.cutoffEnabled === false)
            return (1 + Math.abs(x) * options.compression / BASE_HALF_WIDTH) ** -options.spacingFalloff;
        return (1 - Math.abs(x) / options.cutoffDistance) ** options.spacingFalloff * gate;
    }
    return bellWeight(x, options.compression, options.sharpness) * gate;
}
let lastMapping = null;
// Invert the accumulated density of the app markers. With cutoff enabled,
// steps return to normal beyond its boundary. Without it, use the full distribution.
export function samplingMap(options, normalSize, normalGap) {
    const enabled = options.cutoffEnabled !== false;
    if (options.iconGap === undefined || options.iconGap === normalGap || enabled && options.cutoffDistance <= 0) return x => x;
    const delta = (options.iconGap - normalGap) / (normalSize + normalGap);
    if (!enabled && options.spacingMode === 'uniform') return x => x * (1 + delta);
    const signature = JSON.stringify([options.compression, options.sharpness, enabled, options.cutoffDistance,
        options.cutoffSoftness, options.spacingMode, options.spacingFalloff, options.iconGap, normalSize, normalGap]);
    if (lastMapping?.signature === signature) return lastMapping.map;
    const positions = [0], cumulative = [0];
    const extend = end => {
        const start = positions.at(-1), step = (end - start) / 256;
        for (let i = 1; i <= 256; i++) {
            const density = 1 / Math.max(0.05, 1 + delta * curveSpacingWeight(start + (i - 0.5) * step, options));
            positions.push(start + i * step); cumulative.push(cumulative.at(-1) + step * density);
        }
    };
    // An unbounded curve grows the integration domain as needed rather than
    // silently imposing a second cutoff on its spacing distribution.
    extend(enabled ? options.cutoffDistance : 16 * BASE_HALF_WIDTH / options.compression);
    const map = value => {
        const distance = Math.abs(value), sign = Math.sign(value);
        if (enabled && distance >= cumulative.at(-1))
            return sign * (options.cutoffDistance + distance - cumulative.at(-1));
        while (distance > cumulative.at(-1)) extend(positions.at(-1) * 2);
        let low = 0, high = cumulative.length - 1;
        while (high - low > 1) {const middle = (low + high) >> 1; if (cumulative[middle] < distance) low = middle; else high = middle;}
        return sign * (positions[low] + (positions[high] - positions[low])
            * (distance - cumulative[low]) / (cumulative[high] - cumulative[low]));
    };
    lastMapping = {signature, map};
    return map;
}
