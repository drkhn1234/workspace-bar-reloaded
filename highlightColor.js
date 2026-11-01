import {focusHighlightStops} from './iconTint.js';

const BLACK = {red: 0, green: 0, blue: 0};
const clamp = value => Math.max(0, Math.min(1, value));
const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const encoded = value => value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;

export function relativeLuminance(color) {
    return 0.2126 * linear(color.red / 255) + 0.7152 * linear(color.green / 255) + 0.0722 * linear(color.blue / 255);
}

export function highlightContrastRatio(color, background = BLACK, opacity = 0.8) {
    const composite = Object.fromEntries(['red', 'green', 'blue'].map(channel =>
        [channel, color[channel] * opacity + background[channel] * (1 - opacity)]));
    const a = relativeLuminance(composite), b = relativeLuminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Oklab matrices: https://bottosson.github.io/posts/oklab/
export function rgbToOklab(color) {
    const r = linear(color.red / 255), g = linear(color.green / 255), b = linear(color.blue / 255);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s};
}

function oklabToLinear({L, a, b}) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}

function displayColor(lab) {
    const inGamut = rgb => rgb.every(value => value >= -1e-7 && value <= 1 + 1e-7);
    let rgb = oklabToLinear(lab);
    if (!inGamut(rgb)) {
        // Reduce chroma only when necessary to fit sRGB; keep the hue direction.
        let low = 0, high = 1;
        for (let i = 0; i < 12; i++) {
            const amount = (low + high) / 2;
            if (inGamut(oklabToLinear({...lab, a: lab.a * amount, b: lab.b * amount}))) low = amount;
            else high = amount;
        }
        rgb = oklabToLinear({...lab, a: lab.a * low, b: lab.b * low});
    }
    return Object.fromEntries(['red', 'green', 'blue'].map((channel, i) => [channel, Math.round(encoded(clamp(rgb[i])) * 255)]));
}

export function visibleHighlightColor(color, background = BLACK) {
    if (highlightContrastRatio(color, background) >= 3) return color;
    const lab = rgbToOklab(color);
    const atLightness = L => {
        // Scale chroma with lightness to retain saturation. Keeping absolute
        // chroma while lifting a very dark blue produces a nearly grey core.
        const gain = lab.L > 1e-6 ? L / lab.L : 1;
        return displayColor({L, a: lab.a * gain, b: lab.b * gain});
    };
    const candidates = [];
    for (const destination of [0, 1]) {
        if (highlightContrastRatio(atLightness(destination), background) < 3) continue;
        let low = 0, high = 1;
        for (let i = 0; i < 16; i++) {
            const amount = (low + high) / 2;
            const candidate = atLightness(lab.L + (destination - lab.L) * amount);
            if (highlightContrastRatio(candidate, background) >= 3) high = amount;
            else low = amount;
        }
        const L = lab.L + (destination - lab.L) * high;
        candidates.push({color: atLightness(L), distance: Math.abs(L - lab.L)});
    }
    // The target is for the centre at the default 80% opacity. User opacity
    // remains an independent multiplier, including an intentional zero.
    return candidates.sort((a, b) => a.distance - b.distance)[0]?.color ?? color;
}

export function focusHighlightGradient(tint, options = {}, background = BLACK) {
    const automatic = !options.focusHighlightColorMode || options.focusHighlightColorMode === 'icon';
    const core = automatic ? visibleHighlightColor(tint, background ?? BLACK) : tint;
    const softness = clamp(options.focusHighlightSoftness ?? 1), edge = 1 - softness;
    const coreLab = core !== tint ? rgbToOklab(core) : null, tintLab = coreLab ? rgbToOklab(tint) : null;
    return focusHighlightStops(options).map(([position, alpha]) => {
        // Keep the correction throughout the visible centre, then fade only
        // halfway back to the asset tint. A black outer body hid the blue glow.
        const falloff = softness ? clamp(((position - edge) / softness - 0.35) / 0.65) : 0;
        const weight = 1 - falloff * 0.5;
        let color = tint;
        if (coreLab && weight > 0) color = weight >= 1 ? core : displayColor({
            L: tintLab.L + (coreLab.L - tintLab.L) * weight,
            a: tintLab.a + (coreLab.a - tintLab.a) * weight,
            b: tintLab.b + (coreLab.b - tintLab.b) * weight});
        return {position, alpha, color};
    });
}
