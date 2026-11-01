import assert from 'node:assert/strict';
import test from 'node:test';
import {computeMagnificationLayout} from '../magnificationLayout.js';
import {easeMagnification} from '../magnificationSettings.js';

const items = [
    {x: 100, y: 1, width: 33, height: 30, workspace: 0, isWorkspaceNumber: true},
    {x: 139, y: 3, width: 26, height: 26, workspace: 0},
    {x: 171, y: 3, width: 26, height: 26, workspace: 0},
    {x: 240, y: 1, width: 33, height: 30, workspace: 1, isWorkspaceNumber: true},
    {x: 279, y: 3, width: 26, height: 26, workspace: 1},
];
const options = {icons: items, pointerX: 152, progress: 1, maxSize: 65,
    left: 0, right: 1200, appSpacing: 6};

test('reach and sharpness change neighbouring sizes while retaining the hovered peak', () => {
    const narrow = computeMagnificationLayout({...options, reach: 1});
    const broad = computeMagnificationLayout({...options, reach: 5});
    assert.equal(narrow[1].width, 65);
    assert.equal(broad[1].width, 65);
    assert.ok(broad[2].width > narrow[2].width);
    const soft = computeMagnificationLayout({...options, sharpness: 0.5});
    const sharp = computeMagnificationLayout({...options, sharpness: 3});
    assert.ok(soft[2].width > sharp[2].width);
});

test('physical-distance mode restores the effect of wide workspace separators on app sizes', () => {
    const pointerX = (184 + 292) / 2;
    const packed = computeMagnificationLayout({...options, pointerX});
    const physical = computeMagnificationLayout({...options, pointerX, appOnly: false});
    assert.ok(packed[2].width > physical[2].width);
    assert.ok(packed[4].width > physical[4].width);
});

test('number growth and number modes can be changed without altering app magnification', () => {
    const normal = computeMagnificationLayout(options);
    const fixed = computeMagnificationLayout({...options, numberScale: 0});
    const larger = computeMagnificationLayout({...options, numberScale: 2});
    assert.equal(fixed[0].width, items[0].width);
    assert.ok(larger[0].width > normal[0].width);
    assert.equal(larger[1].width, normal[1].width);
    const disabled = computeMagnificationLayout({...options, numberMode: 'none'});
    assert.equal(disabled[0].width, items[0].width);
    const own = computeMagnificationLayout({...options, numberMode: 'own-workspace'});
    assert.equal(own[0].width, items[0].width);
    assert.equal(own[1].width, normal[1].width);
});

test('custom app and own-number gaps are independent controls', () => {
    const layout = computeMagnificationLayout({...options, iconGap: 14, numberGap: 23});
    assert.ok(Math.abs(layout[1].x - layout[0].x - layout[0].width - 23) < 0.001);
    assert.ok(Math.abs(layout[2].x - layout[1].x - layout[1].width - 14) < 0.001);
});

test('nearby-empty-number preference does not bypass the own-workspace mode for populated numbers', () => {
    const icons = items.map(icon => icon.isWorkspaceNumber ? {...icon, independentHover: 0} : icon);
    const layout = computeMagnificationLayout({...options, icons, pointerX: 116.5,
        numberMode: 'own-workspace', emptyHoverOnly: false});
    assert.equal(layout[0].width, icons[0].width);
    assert.ok(layout[1].width > icons[1].width);
});

test('centre-line alignment and offsets apply in the desktop direction for either panel edge', () => {
    for (const bottom of [false, true]) {
        const centered = computeMagnificationLayout({...options, bottom, verticalAlignment: 'center-line'});
        const centers = centered.map(item => item.y + item.height / 2);
        assert.ok(centers.every(center => Math.abs(center - centers[0]) < 0.001));
        const shifted = computeMagnificationLayout({...options, bottom,
            verticalAlignment: 'center-line', lift: 10, numberOffset: 7});
        const direction = bottom ? -1 : 1;
        assert.ok(Math.abs(shifted[1].y - centered[1].y - direction * 10) < 0.001);
        assert.ok(Math.abs(shifted[0].y - centered[0].y - direction * 17) < 0.001);
    }
});

test('easing choices have the same endpoints and distinct timing', () => {
    for (const mode of ['linear', 'ease-out', 'ease-in-out']) {
        assert.equal(easeMagnification(0, mode), 0);
        assert.equal(easeMagnification(1, mode), 1);
        let previous = -1;
        for (let t = 0; t <= 1; t += 0.01) {
            const value = easeMagnification(t, mode);
            assert.ok(value >= previous);
            previous = value;
        }
    }
    assert.equal(easeMagnification(0.25, 'linear'), 0.25);
    assert.ok(easeMagnification(0.25, 'ease-out') > 0.25);
    assert.ok(easeMagnification(0.25, 'ease-in-out') < 0.25);
});

test('custom app gaps preserve distant spacing and never change app scales', () => {
    for (const pointerX of [100, 152, 210, 270, 1000]) {
        const normal = computeMagnificationLayout({...options, pointerX, appSpacing: 6});
        for (const iconGap of [0, 20, 64]) {
            const custom = computeMagnificationLayout({...options, pointerX, iconGap, appSpacing: 6});
            assert.deepEqual(custom.map(item => item.width), normal.map(item => item.width));
            if (pointerX === 1000) assert.equal(custom[2].x - custom[1].x - custom[1].width, 6);
        }
    }
});

test('normal-size numbers and zero number growth share the same vertical alignment', () => {
    for (const bottom of [false, true]) for (const progress of [0, 0.3, 1]) {
        const zero = computeMagnificationLayout({...options, bottom, progress, numberScale: 0});
        const none = computeMagnificationLayout({...options, bottom, progress, numberMode: 'none'});
        for (const index of [0, 3]) {
            assert.equal(zero[index].width, none[index].width);
            assert.equal(zero[index].y, none[index].y);
        }
    }
});

test('every allowed sharpness is monotonic and meets the normal size with a flat slope', async () => {
    const {magnificationWeight} = await import('../magnificationLayout.js');
    for (const sharpness of [0.25, 0.5, 1, 2, 4]) {
        assert.equal(magnificationWeight(0, sharpness), 1);
        assert.equal(magnificationWeight(1, sharpness), 0);
        let previous = 1;
        for (let i = 0; i <= 1000; i++) {
            const weight = magnificationWeight(i / 1000, sharpness);
            assert.ok(weight >= 0 && weight <= previous); previous = weight;
        }
        const slope = delta => magnificationWeight(1 - delta, sharpness) / delta;
        assert.ok(slope(0.0001) < slope(0.001) * 0.11);
    }
});

test('peak units have literal semantics without an independent size floor', async () => {
    const {peakIconSize} = await import('../magnificationSettings.js');
    for (const normal of [16, 20, 26]) {
        assert.equal(peakIconSize({peakMode: 'relative', scale: 1}, normal), normal);
        assert.equal(peakIconSize({peakMode: 'relative', scale: 2.5}, normal), Math.round(normal * 2.5));
        assert.equal(peakIconSize({peakMode: 'pixels', peakPixels: 64}, normal), 64);
        assert.equal(peakIconSize({peakMode: 'pixels', peakPixels: 1}, normal), normal);
    }
});

test('migration preserves legacy peak sizes and runs only once', async () => {
    const {migrateMagnificationSettings, peakIconSize, readMagnificationOptions} = await import('../magnificationSettings.js');
    for (const normal of [16, 20, 26]) for (const floor of [0, 48, 256]) {
        const values = {'magnification-settings-version': 0, 'magnification-scale': 250,
            'magnification-minimum-peak-size': floor, 'magnification-peak-mode': 'relative', 'magnification-peak-pixels': 50};
        const settings = {get_int: k => values[k] ?? 0, get_boolean: () => false, get_string: k => values[k],
            set_int: (k, v) => values[k] = v, set_string: (k, v) => values[k] = v};
        const preset = {iconSize: normal, iconSpacing: 6};
        migrateMagnificationSettings(settings, preset);
        assert.equal(peakIconSize(readMagnificationOptions(settings, preset), normal), Math.max(floor, Math.round(normal * 2.5)));
        settings.set_string('magnification-peak-mode', 'relative'); settings.set_int('magnification-scale', 100);
        migrateMagnificationSettings(settings, preset);
        assert.equal(peakIconSize(readMagnificationOptions(settings, preset), normal), normal);
    }
});
