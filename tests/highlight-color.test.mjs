import assert from 'node:assert/strict';
import test from 'node:test';
import {relativeLuminance, rgbToOklab, highlightContrastRatio, visibleHighlightColor, focusHighlightGradient} from '../highlightColor.js';
import {focusHighlightStops} from '../iconTint.js';

const black = {red: 0, green: 0, blue: 0}, white = {red: 255, green: 255, blue: 255};
const terminal = Object.freeze({red: 11, green: 37, blue: 175});
const hue = color => {const lab = rgbToOklab(color); return Math.atan2(lab.b, lab.a);};
const hueDistance = (a, b) => Math.abs(Math.atan2(Math.sin(hue(a) - hue(b)), Math.cos(hue(a) - hue(b))));

test('visibility accounts for perceived brightness rather than the largest RGB channel', () => {
    assert.equal(relativeLuminance(black), 0);
    assert.equal(relativeLuminance(white), 1);
    assert.ok(relativeLuminance({red: 0, green: 160, blue: 0}) > relativeLuminance({red: 0, green: 0, blue: 160}));
    assert.ok(highlightContrastRatio(terminal) < 3);
    const corrected = visibleHighlightColor(terminal);
    assert.ok(highlightContrastRatio(corrected) >= 3);
    assert.ok(rgbToOklab(corrected).L > rgbToOklab(terminal).L);
    assert.ok(hueDistance(terminal, corrected) < 0.03);
});

test('saturated blue stays in gamut while its perceptual hue is retained', () => {
    const blue = {red: 0, green: 0, blue: 255}, corrected = visibleHighlightColor(blue);
    assert.ok(highlightContrastRatio(corrected) >= 3);
    assert.ok(hueDistance(blue, corrected) < 0.03);
    assert.ok(Object.values(corrected).every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255));
});

test('already visible vibrant colours are unchanged', () => {
    for (const color of [{red: 44, green: 202, blue: 116}, {red: 53, green: 132, blue: 228}, white])
        assert.equal(visibleHighlightColor(color), color);
});

test('visibility also adapts to a light panel backdrop', () => {
    const pale = {red: 245, green: 245, blue: 160}, corrected = visibleHighlightColor(pale, white);
    assert.ok(highlightContrastRatio(corrected, white) >= 3);
    assert.ok(relativeLuminance(corrected) < relativeLuminance(pale));
    assert.ok(hueDistance(pale, corrected) < 0.03);
});

test('a broad visible centre and outer glow keep the icon hue', () => {
    const options = {focusHighlightColorMode: 'icon', focusHighlightOpacity: 0.65, focusHighlightSoftness: 0.5};
    const gradient = focusHighlightGradient(terminal, options);
    assert.ok(relativeLuminance(gradient[0].color) > relativeLuminance(terminal));
    assert.deepEqual(gradient[2].color, gradient[0].color);
    assert.ok(relativeLuminance(gradient.at(-2).color) > relativeLuminance(terminal));
    assert.ok(gradient.at(-2).color.blue > gradient.at(-2).color.green * 2);
    assert.ok(hueDistance(gradient.at(-2).color, terminal) < 0.03);
    assert.deepEqual(gradient.map(({position, alpha}) => [position, alpha]), focusHighlightStops(options));
});

test('lifting a nearly black blue keeps saturation rather than producing grey', () => {
    const dark = {red: 1, green: 3, blue: 20};
    const core = visibleHighlightColor(dark);
    assert.ok(highlightContrastRatio(core) >= 3);
    assert.ok(core.blue > core.green * 2 && core.blue > core.red * 3);
    assert.ok(hueDistance(core, dark) < 0.03);
});

test('user opacity remains independent and zero always hides the highlight', () => {
    const faint = focusHighlightGradient(terminal, {focusHighlightOpacity: 0.1});
    const opaque = focusHighlightGradient(terminal, {focusHighlightOpacity: 1});
    assert.deepEqual(faint[0].color, opaque[0].color);
    assert.equal(faint[0].alpha, 0.1);
    assert.ok(focusHighlightGradient(terminal, {focusHighlightOpacity: 0}).every(stop => stop.alpha === 0));
    const solid = focusHighlightGradient(terminal, {focusHighlightSoftness: 0});
    assert.ok(solid.every(stop => stop.alpha === 0.8));
    assert.deepEqual(solid[0].color, solid[1].color);
});

test('accent and custom colours bypass automatic correction', () => {
    for (const mode of ['accent', 'custom']) {
        const gradient = focusHighlightGradient(terminal, {focusHighlightColorMode: mode});
        assert.ok(gradient.every(stop => stop.color === terminal));
    }
});

test('representative colours reach the reference contrast on dark, grey and white backdrops', () => {
    const colors = [terminal, {red: 255, green: 0, blue: 0}, {red: 0, green: 255, blue: 0},
        {red: 0, green: 0, blue: 255}, {red: 200, green: 60, blue: 190},
        ...Array.from({length: 16}, (_, i) => ({red: i * 17, green: i * 17, blue: i * 17}))];
    for (const background of [black, {red: 32, green: 32, blue: 32}, {red: 128, green: 128, blue: 128}, white])
        for (const color of colors) assert.ok(highlightContrastRatio(visibleHighlightColor(color, background), background) >= 3,
            JSON.stringify({color, background}));
});
