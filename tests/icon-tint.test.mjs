import assert from 'node:assert/strict';
import test from 'node:test';
import {dominantIconTint, visibleIconBounds, focusShadowGeometry, focusHighlightStops, focusHighlightColor} from '../iconTint.js';

test('transparent padding does not change the icon tint', () => {
    const pixels = new Uint8Array([255, 0, 0, 0, 20, 100, 220, 255, 255, 0, 0, 20]);
    assert.deepEqual(dominantIconTint(pixels, 3, 1, 12, 4), {red: 20, green: 100, blue: 220});
});

test('neutral borders do not overwhelm a coloured app emblem', () => {
    const pixels = new Uint8Array([...Array(5).fill([245, 245, 245, 255]).flat(), 20, 100, 220, 255]);
    assert.deepEqual(dominantIconTint(pixels, 6, 1, 24, 4), {red: 20, green: 100, blue: 220});
});

test('a textured blue screen wins over concentrated black and silver pixels', () => {
    const pixels = new Uint8Array([
        ...Array(90).fill([2, 7, 13, 255]).flat(),
        ...Array(20).fill([220, 220, 220, 255]).flat(),
        ...Array.from({length: 40}, (_, i) => [8, 20 + i, 60 + i * 4, 255]).flat(),
    ]);
    const tint = dominantIconTint(pixels, 150, 1, 600, 4);
    assert.ok(tint.blue > 100 && tint.blue > tint.green * 3 && tint.red < 20);
});

test('a tiny coloured speck does not recolour an otherwise monochrome icon', () => {
    const pixels = new Uint8Array([...Array(100).fill([80, 80, 80, 255]).flat(), 255, 0, 0, 255]);
    assert.deepEqual(dominantIconTint(pixels, 101, 1, 404, 4), {red: 80, green: 80, blue: 80});
});

test('dominant colours stay distinct instead of blending contrasting hues', () => {
    const pixels = new Uint8Array([230, 30, 10, 255, 220, 25, 15, 255, 20, 30, 230, 255]);
    const tint = dominantIconTint(pixels, 3, 1, 12, 4);
    assert.ok(tint.red > 200 && tint.blue < 30);
});

test('RGB rows respect padding bytes', () => {
    const pixels = new Uint8Array([10, 200, 30, 255, 10, 200, 30]);
    assert.deepEqual(dominantIconTint(pixels, 1, 2, 4, 3), {red: 10, green: 200, blue: 30});
});

test('palette extraction preserves dark colours for the outer highlight', () => {
    assert.deepEqual(dominantIconTint(new Uint8Array([0, 50, 0]), 1, 1, 3, 3), {red: 0, green: 50, blue: 0});
    assert.deepEqual(dominantIconTint(new Uint8Array([0, 0, 0]), 1, 1, 3, 3), {red: 0, green: 0, blue: 0});
});

test('empty transparent icons request a fallback', () => {
    assert.equal(dominantIconTint(new Uint8Array(16), 2, 2, 8, 4), null);
});

test('visible icon bounds exclude transparent padding and faint baked-in shadows', () => {
    const pixels = new Uint8Array(5 * 6 * 4);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) pixels[(y * 5 + x) * 4 + 3] = 255;
    pixels[(5 * 5 + 2) * 4 + 3] = 12;
    assert.deepEqual(visibleIconBounds(pixels, 5, 6, 20, 4),
        {x: 1, y: 1, width: 3, height: 3, canvasWidth: 5, canvasHeight: 6});
    assert.equal(visibleIconBounds(new Uint8Array(16), 2, 2, 8, 4), null);
});

test('shadow offset follows the lowest visible pixel instead of icon canvas padding', () => {
    const target = {x: 100, y: 100, width: 100, height: 100}, monitor = {y: 0, height: 1000};
    const padded = focusShadowGeometry(target, {x: 10, y: 10, width: 80, height: 60, canvasWidth: 100, canvasHeight: 100}, monitor);
    const full = focusShadowGeometry(target, null, monitor);
    assert.equal(padded.y + padded.height / 2, 173);
    assert.equal(full.y + full.height / 2, 205);
    assert.equal(padded.x + padded.width / 2, 150);
});

test('a bottom-panel shadow keeps its bright centre below the icon rather than moving behind it', () => {
    const shadow = focusShadowGeometry({x: 100, y: 100, width: 100, height: 100},
        {x: 0, y: 0, width: 100, height: 96, canvasWidth: 100, canvasHeight: 100}, {y: 0, height: 200});
    assert.ok(shadow.y + shadow.height / 2 > 196);
    assert.ok(shadow.y + shadow.height / 2 < 200);
    assert.ok(shadow.y + shadow.height > 200);
});

test('icon fitting and monitor coordinates are preserved when locating the shadow', () => {
    const shadow = focusShadowGeometry({x: 500, y: -100, width: 100, height: 100},
        {x: 0, y: 0, width: 20, height: 40, canvasWidth: 20, canvasHeight: 40}, {y: -900, height: 1000});
    assert.equal(shadow.x + shadow.width / 2, 550);
    assert.equal(shadow.y + shadow.height / 2, 5);
    assert.equal(shadow.width, 120);
});

test('highlight size and extra offset can change independently of its automatic anchor', () => {
    const target = {x: 100, y: 100, width: 100, height: 100}, monitor = {y: 0, height: 1000};
    const base = focusShadowGeometry(target, null, monitor);
    const custom = focusShadowGeometry(target, null, monitor, {focusHighlightWidth: 1.5, focusHighlightHeight: 0.5, focusHighlightOffset: 8});
    assert.equal(custom.width, base.width * 1.5); assert.equal(custom.height, base.height * 0.5);
    assert.equal(custom.x + custom.width / 2, base.x + base.width / 2);
    assert.equal(custom.y + custom.height / 2, base.y + base.height / 2 + 8);
    const raised = focusShadowGeometry(target, null, monitor, {focusHighlightOffset: -5});
    assert.equal(raised.y + raised.height / 2, base.y + base.height / 2 - 5);
});

test('highlight opacity and softness change the rendered gradient', () => {
    assert.equal(focusHighlightStops()[0][1], 0.8);
    assert.ok(focusHighlightStops({focusHighlightOpacity: 0}).every(([, alpha]) => alpha === 0));
    assert.deepEqual(focusHighlightStops({focusHighlightOpacity: 0.25, focusHighlightSoftness: 0}), [[0, 0.25], [1, 0.25]]);
    const soft = focusHighlightStops({focusHighlightSoftness: 1}), sharp = focusHighlightStops({focusHighlightSoftness: 0.25});
    assert.ok(sharp[1][0] > soft[1][0]);
    assert.equal(sharp.at(-1)[1], 0);
});

test('highlight colours can follow the app, accent or a custom colour', () => {
    const icon = {red: 20, green: 100, blue: 220};
    assert.equal(focusHighlightColor(icon, '#ff3300'), icon);
    assert.deepEqual(focusHighlightColor(icon, '#ff3300', {focusHighlightColorMode: 'accent'}), {red: 255, green: 51, blue: 0});
    assert.deepEqual(focusHighlightColor(icon, '#ff3300', {focusHighlightColorMode: 'custom', focusHighlightColor: '#AABBCC'}), {red: 170, green: 187, blue: 204});
    assert.deepEqual(focusHighlightColor(icon, null, {focusHighlightColorMode: 'custom', focusHighlightColor: 'invalid'}), {red: 53, green: 132, blue: 228});
});
