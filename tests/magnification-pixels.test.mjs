import test from 'node:test';
import assert from 'node:assert/strict';
import {bellWeight, curveWeight, curveSpacingWeight, effectiveCompression, samplingMap} from '../magnificationCurve.js';
import {magnificationGraphModel, magnificationGraphViewport} from '../magnificationGraphModel.js';
import {computeMagnificationLayout} from '../magnificationLayout.js';
const config = {compression: 1, sharpness: 1, cutoffDistance: 96, cutoffSoftness: 0,
    adaptiveReach: false, reachReference: 8, spacingMode: 'curve', spacingFalloff: 1, graphSpan: 192, maxSize: 65};
const close = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('horizontal compression is precisely the transformation f(c*x)', () => {
    for (const x of [-150, -32, -5, 0, 5, 32, 150]) for (const c of [0.05, 0.25, 0.5, 1, 2, 8, 16]) {
        close(bellWeight(x, c), bellWeight(c * x, 1));
        close(bellWeight(x, c), bellWeight(-x, c));
    }
    close(bellWeight(32), 0.5);
    assert.ok(bellWeight(96) > 0); // no finite natural reach
});

test('adding apps never stretches the fixed pixel curve or the graph view', () => {
    const small = magnificationGraphModel(config, 26, 6, 3);
    const large = magnificationGraphModel(config, 26, 6, 31);
    assert.equal(small.extent, 192); assert.equal(large.extent, 192);
    for (const x of [-100, -40, 0, 40, 100]) close(small.kernelScaleAt(x), large.kernelScaleAt(x));
});

test('one unit remains one logical pixel across icon size presets', () => {
    const small = magnificationGraphModel({...config, maxSize: 40}, 16, 3, 9);
    const large = magnificationGraphModel({...config, maxSize: 65}, 26, 6, 9);
    for (const x of [-80, -32, 0, 32, 80]) close(small.kernelScaleAt(x), large.kernelScaleAt(x));
});

test('pixel cutoff is independent of compression and clips size and spacing exactly', () => {
    for (const compression of [0.25, 1, 8]) for (const spacingMode of ['uniform', 'curve', 'diminishing']) {
        const options = {...config, compression, spacingMode, cutoffDistance: 60};
        for (const x of [-100, -60, 60, 100]) {
            assert.equal(curveWeight(x, options), 0);
            assert.equal(curveSpacingWeight(x, options), 0);
        }
        assert.ok(curveWeight(59, options) > 0);
    }
});

test('soft cutoff blends only inside its pixel boundary', () => {
    const options = {...config, cutoffDistance: 60, cutoffSoftness: 0.2};
    close(curveWeight(20, options), curveWeight(20, {...options, cutoffSoftness: 0}));
    assert.ok(curveWeight(59, options) < curveWeight(59, {...options, cutoffSoftness: 0}));
    assert.equal(curveWeight(60, options), 0);
});

test('pixel graph markers sample the very same curve as the runtime', () => {
    for (const count of [1, 2, 9, 31]) for (const spacingMode of ['uniform', 'curve', 'diminishing']) {
        const graph = magnificationGraphModel({...config, spacingMode, iconGap: 24}, 26, 6, count);
        for (let i = 0; i < count; i++) {
            close(graph.markers[i].x, -graph.markers[count - 1 - i].x);
            close(graph.markers[i].y, graph.scaleAt(graph.markers[i].x));
        }
    }
});

test('marker spacing changes sampling positions without changing f(cx)', () => {
    const tight = magnificationGraphModel({...config, iconGap: 0}, 26, 6, 9);
    const wide = magnificationGraphModel({...config, iconGap: 40}, 26, 6, 9);
    assert.ok(wide.markers[5].x > tight.markers[5].x);
    assert.ok(wide.markers[5].y < tight.markers[5].y);
    for (const x of [0, 16, 32, 80]) close(wide.kernelScaleAt(x), tight.kernelScaleAt(x));
});

test('marker coordinates remain monotonic and use normal steps outside cutoff', () => {
    for (const spacingMode of ['uniform', 'curve', 'diminishing']) for (const iconGap of [0, 64]) {
        const map = samplingMap({...config, spacingMode, iconGap}, 26, 6);
        let previous = -Infinity;
        for (let x = -300; x <= 300; x += 0.5) {assert.ok(map(x) > previous); previous = map(x);}
        close(map(400) - map(368), 32);
        close(map(-368) - map(-400), 32);
    }
});

test('count-dependent compression is opt-in and bounded by the configured base', () => {
    assert.equal(effectiveCompression(1, 2, false, 8), 1);
    assert.equal(effectiveCompression(1, 2, true, 8, 'fewer'), 4);
    assert.equal(effectiveCompression(1, 16, true, 8, 'more'), 2);
    assert.equal(effectiveCompression(1, 16, true, 8, 'fewer'), 1);
});

test('zero pixel cutoff restores runtime scales and gaps even with custom marker spacing', () => {
    const icons = Array.from({length: 9}, (_, i) => ({x: i * 32, y: 0, width: 26, height: 26, workspace: 0}));
    const result = computeMagnificationLayout({...config, cutoffDistance: 0, iconGap: 64,
        icons, pointerX: 141, progress: 1, left: -1000, right: 2000, appSpacing: 6});
    for (const item of result) close(item.width, 26);
    for (let i = 1; i < result.length; i++) close(result[i].x - result[i - 1].x - result[i - 1].width, 6);
});

test('legacy reach and percentage cutoff migrate to c and logical pixel distance once', async () => {
    const {migrateMagnificationSettings} = await import('../magnificationSettings.js');
    const values = {'magnification-settings-version': 1, 'magnification-scale': 250,
        'magnification-minimum-peak-size': 48, 'magnification-reach': 300, 'magnification-cutoff': 50};
    const settings = {get_int: key => values[key], get_user_value: key => key === 'magnification-reach' ? 300 : null,
        set_int: (key, value) => values[key] = value};
    migrateMagnificationSettings(settings, {iconSize: 26});
    assert.equal(values['magnification-compression'], 82);
    assert.equal(values['magnification-cutoff-distance'], 39);
    values['magnification-compression'] = 150;
    migrateMagnificationSettings(settings, {iconSize: 26});
    assert.equal(values['magnification-compression'], 150);
});

test('fixed-pixel magnification keeps app targets pinned when large gaps cannot fit the row', () => {
    const icons = Array.from({length: 15}, (_, i) => ({x: 100 + i * 32, y: 0, width: 26, height: 26, workspace: i >> 1}));
    for (const index of [4, 7, 10]) {
        const pointerX = icons[index].x + 13;
        const layout = computeMagnificationLayout({...config, icons, pointerX, progress: 1,
            spacing: 64, left: 100, right: 580, appSpacing: 6});
        close(layout[index].x + layout[index].width / 2, pointerX);
        assert.ok(layout[index].x >= 100 && layout[index].x + layout[index].width <= 580);
    }
});

test('graph markers use the real packed positions, dimensions and top edges', () => {
    for (const verticalAlignment of ['panel-edge', 'center-line']) for (const lift of [0, 12]) {
        const graph = magnificationGraphModel({...config, iconGap: 24, verticalAlignment, lift}, 26, 6, 9);
        graph.markers.forEach((marker, index) => {
            const actual = graph.packed[index];
            close(marker.x, actual.x + actual.width / 2);
            close(marker.top, actual.y); close(marker.width, actual.width); close(marker.height, actual.height);
            close(graph.topAt(marker.x) - lift, actual.y);
            close(graph.toSource(marker.x), marker.sampleX);
        });
    }
});

test('100 percent matches shell pixel dimensions and zoom preserves both axes equally', () => {
    const graph = magnificationGraphModel({...config, iconGap: 24}, 26, 6, 9);
    for (const zoom of [0.05, 0.25, 1, 2]) {
        const view = magnificationGraphViewport(graph, 960, 260, zoom);
        close(view.unitX, zoom); close(view.unitY, graph.normalSize * zoom);
        graph.markers.forEach(marker => {
            close(view.px(marker.x + marker.width / 2) - view.px(marker.x - marker.width / 2), marker.width * zoom);
            close(view.physicalY(marker.top + marker.height) - view.physicalY(marker.top), marker.height * zoom);
            close(view.py(marker.y), view.physicalY(marker.top));
        });
        for (let i = 1; i < graph.markers.length; i++) {
            const a = graph.markers[i - 1], b = graph.markers[i];
            const gap = b.x - b.width / 2 - a.x - a.width / 2;
            close(view.px(b.x - b.width / 2) - view.px(a.x + a.width / 2), gap * zoom);
        }
    }
});

test('resizing the editor expands the view without stretching its physical coordinates', () => {
    const graph = magnificationGraphModel(config, 26, 6, 9);
    for (const width of [480, 960, 1400]) {
        const view = magnificationGraphViewport(graph, width, 260, 1);
        close(view.px(64) - view.px(0), 64);
        close(view.physicalY(64) - view.physicalY(0), 64);
    }
});

test('editing peak size keeps the panel baseline fixed within the graph viewport', () => {
    const small = magnificationGraphModel({...config, maxSize: 50}, 20, 5, 9);
    const large = magnificationGraphModel({...config, maxSize: 65}, 20, 5, 9);
    const a = magnificationGraphViewport(small, 960, 240, 1);
    const b = magnificationGraphViewport(large, 960, 240, 1);
    close(a.floor, b.floor); close(a.baseline, b.baseline);
    close(a.py(small.peak) - b.py(large.peak), 15);
});

test('disabling cutoff exposes the unbounded bell without changing its saved distance', () => {
    for (const cutoffDistance of [0, 10, 96]) {
        const options = {...config, cutoffEnabled: false, cutoffDistance, cutoffSoftness: 0.5};
        for (const x of [-128, -32, 0, 32, 128]) close(curveWeight(x, options), bellWeight(x));
        assert.ok(curveWeight(128, options) > 0);
    }
});

test('spacing remains defined for every x with cutoff disabled', () => {
    for (const spacingMode of ['uniform', 'curve', 'diminishing']) {
        const options = {...config, cutoffEnabled: false, cutoffDistance: 0, spacingMode};
        assert.ok(curveSpacingWeight(128, options) > 0);
        close(curveSpacingWeight(128, options), curveSpacingWeight(128, {...options, cutoffDistance: 1000}));
    }
    assert.equal(curveSpacingWeight(10000, {...config, cutoffEnabled: false, spacingMode: 'uniform'}), 1);
});

test('unbounded sampling ignores disabled cutoff controls and stays symmetric and monotonic', () => {
    for (const spacingMode of ['uniform', 'curve', 'diminishing']) {
        const a = samplingMap({...config, cutoffEnabled: false, cutoffDistance: 0, spacingMode, iconGap: 24}, 26, 6);
        const b = samplingMap({...config, cutoffEnabled: false, cutoffDistance: 1000, cutoffSoftness: 0.5, spacingMode, iconGap: 24}, 26, 6);
        let previous = -Infinity;
        for (const x of [-100000, -500, -100, -32, 0, 32, 100, 500, 100000]) {
            assert.ok(a(x) > previous); previous = a(x);
            close(a(x), b(x)); close(a(-x), -a(x));
        }
    }
});

test('uniform unbounded spacing uses the custom step even far from the cursor', () => {
    const map = samplingMap({...config, cutoffEnabled: false, spacingMode: 'uniform', iconGap: 24}, 26, 6);
    for (const x of [-10000, 0, 10000]) close(map(x + 32) - map(x), 50);
});

test('diminishing spacing does not acquire a hidden finite cutoff in its numerical integration', () => {
    const map = samplingMap({...config, cutoffEnabled: false, spacingMode: 'diminishing', spacingFalloff: 0.25, iconGap: 64}, 26, 6);
    assert.ok(map(1000032) - map(1000000) > 32.1);
});

test('runtime cutoff-off overrides a zero boundary and graph markers still match the physical layout', () => {
    const graph = magnificationGraphModel({...config, cutoffEnabled: false, cutoffDistance: 0}, 26, 6, 9);
    assert.equal(graph.cutoffEnabled, false);
    assert.ok(graph.shoulder.y > 1);
    assert.ok(graph.markers[5].y > 1);
    graph.markers.forEach(marker => close(graph.scaleAt(marker.x), marker.y));
    const restored = magnificationGraphModel({...config, cutoffEnabled: true, cutoffDistance: 0}, 26, 6, 9);
    restored.markers.forEach(marker => close(marker.y, 1));
});


test('Lift moves icons while the curve, axes and canvas dimensions stay fixed', () => {
    for (const verticalAlignment of ['panel-edge', 'center-line']) {
        const normal = magnificationGraphModel({...config, verticalAlignment, lift: 0}, 26, 6, 9);
        const lifted = magnificationGraphModel({...config, verticalAlignment, lift: 52}, 26, 6, 9);
        const normalView = magnificationGraphViewport(normal, 960, 320, 1);
        const liftedView = magnificationGraphViewport(lifted, 960, 320, 1);
        close(normalView.contentHeight, liftedView.contentHeight);
        close(normalView.baseline, liftedView.baseline);
        for (const x of [-96, -32, 0, 32, 96]) close(normal.topAt(x), lifted.topAt(x));
        close(normalView.py(normal.peak), liftedView.py(lifted.peak));
        normal.markers.forEach((marker, i) => {
            close(marker.width, lifted.markers[i].width);
            close(normalView.physicalY(marker.top) - liftedView.physicalY(lifted.markers[i].top), 52);
        });
    }
});


test('Lift half steps use normal icon heights and stop at two units', async () => {
    const {snapLiftUnits, liftUnitsForPixels, liftPixelsForUnits} = await import('../magnificationSettings.js');
    close(snapLiftUnits(1.26), 1.5); close(snapLiftUnits(0.74), 0.5);
    close(snapLiftUnits(-2), 0); close(snapLiftUnits(9), 2);
    for (const normal of [16, 20, 26]) for (let units = 0; units <= 2; units += 0.5) {
        close(liftPixelsForUnits(units, normal), units * normal);
        close(liftUnitsForPixels(units * normal, normal), units);
    }
    close(liftUnitsForPixels(128, 26), 2);
});
