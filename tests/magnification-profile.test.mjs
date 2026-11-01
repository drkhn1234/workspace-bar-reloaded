import test from 'node:test';
import assert from 'node:assert/strict';
import {computeMagnificationLayout, profileWeight, spacingWeight, magnificationReach} from '../magnificationLayout.js';
import {magnificationGraphModel} from '../magnificationGraphModel.js';
const options = {maxSize: 65, reach: 3, sharpness: 1, cutoff: 1, cutoffSoftness: 0,
    adaptiveReach: false, reachReference: 8, spacingMode: 'curve', spacingFalloff: 1, iconGap: 20};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('cutoff is an exact piecewise boundary for scale and every spacing mode', () => {
    assert.ok(profileWeight(0.49, 1, 0.5, 0) > 0.5);
    for (const distance of [0.5, 0.6, 1, 2]) {
        assert.equal(profileWeight(distance, 1, 0.5, 0), 0);
        for (const spacingMode of ['uniform', 'curve', 'diminishing'])
            assert.equal(spacingWeight(distance, {spacingMode, cutoff: 0.5, neighbourWeight: 1}), 0);
    }
});

test('soft cutoff transitions entirely inside the boundary', () => {
    close(profileWeight(0, 1, 0.5, 0.2), 1);
    assert.ok(profileWeight(0.49, 1, 0.5, 0.2) < profileWeight(0.49, 1, 0.5, 0));
    assert.equal(profileWeight(0.5, 1, 0.5, 0.2), 0);
    assert.equal(profileWeight(0.8, 1, 0.5, 0.2), 0);
});

test('uniform, bell and diminishing spacing have distinct configurable distributions', () => {
    const settings = {cutoff: 1, spacingFalloff: 2};
    assert.equal(spacingWeight(0.3, {...settings, spacingMode: 'uniform'}), 1);
    assert.ok(spacingWeight(0.3, {...settings, spacingMode: 'curve'}) < 1);
    close(spacingWeight(0.3, {...settings, spacingMode: 'diminishing'}), 0.49);
    assert.ok(spacingWeight(0.6, {...settings, spacingMode: 'diminishing'}) < 0.49);
});

test('adaptive reach shrinks with app count without increasing beyond the configured width', () => {
    assert.equal(magnificationReach(4, 2, true, 8), 1);
    assert.equal(magnificationReach(4, 8, true, 8), 4);
    assert.equal(magnificationReach(4, 20, true, 8), 4);
    assert.equal(magnificationReach(4, 2, false, 8), 4);
    const few = magnificationGraphModel({...options, adaptiveReach: true}, 26, 6, 3);
    const many = magnificationGraphModel({...options, adaptiveReach: true}, 26, 6, 9);
    close(few.markers[1].y, 2.5); close(many.markers[4].y, 2.5);
    assert.ok(few.radius < many.radius);
});

test('the curve and markers are symmetric and every marker lies on the plotted curve', () => {
    for (const count of [1, 2, 3, 8, 9, 31]) for (const spacingMode of ['uniform', 'curve', 'diminishing']) {
        const graph = magnificationGraphModel({...options, spacingMode}, 26, 6, count);
        for (let i = 0; i < count; i++) {
            close(graph.markers[i].x, -graph.markers[count - 1 - i].x);
            close(graph.markers[i].y, graph.markers[count - 1 - i].y);
            close(graph.scaleAt(graph.markers[i].x), graph.markers[i].y);
        }
        for (const x of [0, 0.3, 1, 2, 5]) close(graph.scaleAt(x), graph.scaleAt(-x));
    }
});

test('cutoff graph markers return to exactly normal scale and app gaps', () => {
    for (const spacingMode of ['uniform', 'curve', 'diminishing']) {
        const graph = magnificationGraphModel({...options, cutoff: 0.5, spacingMode}, 26, 6, 15);
        for (const marker of graph.markers.filter(point => Math.abs(point.source) >= graph.radius * 0.5)) close(marker.y, 1);
        close((graph.markers.at(-1).x - graph.markers.at(-2).x) * 26, 32);
        close(graph.scaleAt(graph.cutoffX), 1);
        close(graph.scaleAt(graph.cutoffX + 1), 1);
    }
});

test('changing marker gaps moves markers without altering their scales', () => {
    const tight = magnificationGraphModel({...options, iconGap: 0}, 26, 6, 9);
    const wide = magnificationGraphModel({...options, iconGap: 40}, 26, 6, 9);
    assert.deepEqual(tight.markers.map(p => p.y), wide.markers.map(p => p.y));
    assert.ok(wide.markers[5].x > tight.markers[5].x);
});

test('zero cutoff disables magnification and custom gaps completely', () => {
    const graph = magnificationGraphModel({...options, cutoff: 0}, 26, 6, 9);
    for (const marker of graph.markers) close(marker.y, 1);
    for (let i = 1; i < graph.markers.length; i++) close((graph.markers[i].x - graph.markers[i - 1].x) * 26, 32);
});

test('adaptive app reach excludes workspace-number count', () => {
    const apps = [{x: 100, y: 0, width: 26, height: 26, workspace: 1}, {x: 132, y: 0, width: 26, height: 26, workspace: 1}];
    const numbers = Array.from({length: 10}, (_, i) => ({x: 300 + i * 40, y: 0, width: 33, height: 30, workspace: i + 2, isWorkspaceNumber: true}));
    const config = {...options, adaptiveReach: true, pointerX: 113, progress: 1, left: 0, right: 2000, appSpacing: 6};
    const a = computeMagnificationLayout({...config, icons: apps});
    const b = computeMagnificationLayout({...config, icons: [...apps, ...numbers]});
    close(a[0].width, b[0].width); close(a[1].width, b[1].width);
});

test('short cutoffs retain an editable shoulder inside the unshaded region', () => {
    const graph = magnificationGraphModel({...options, cutoff: 0.2}, 26, 6, 9);
    assert.ok(graph.shoulder.y > 1);
    assert.ok(graph.shoulder.x < graph.cutoffX);
});

test('default bell spacing remains continuous at its natural boundary', () => {
    const icons = Array.from({length: 9}, (_, i) => ({x: i * 32, y: 0, width: 26, height: 26, workspace: 0}));
    let previous;
    for (let pointerX = -100; pointerX < 400; pointerX += 0.25) {
        const layout = computeMagnificationLayout({...options, icons, iconGap: 64, pointerX, progress: 1, left: -1000, right: 2000});
        if (previous) for (let i = 0; i < layout.length; i++) {
            assert.ok(Math.abs(layout[i].x - previous[i].x) < 2);
            assert.ok(Math.abs(layout[i].width - previous[i].width) < 1);
        }
        previous = layout;
    }
});

test('crowded-bar response narrows with more icons and remains bounded for fewer icons', () => {
    assert.equal(magnificationReach(4, 16, true, 8, 'more'), 2);
    assert.equal(magnificationReach(4, 8, true, 8, 'more'), 4);
    assert.equal(magnificationReach(4, 2, true, 8, 'more'), 4);
    const graph = magnificationGraphModel({...options, adaptiveReach: true, reachResponse: 'more'}, 26, 6, 15);
    close(graph.radius, 3 * 8 / 15);
    close(graph.markers[7].y, 2.5);
    for (let i = 0; i < graph.markers.length; i++) close(graph.markers[i].x, -graph.markers[14 - i].x);
});
