import assert from 'node:assert/strict';
import test from 'node:test';
import {computePanelLayout} from '../panelLayout.js';

test('the bar can use the free space beyond the old 40 percent limit', () => {
    const layout = computePanelLayout({
        panelWidth: 1440, naturalWidths: [460, 624, 196],
        viewportWidth: 624, viewportBox: 1,
    });
    assert.equal(layout.availableWidth, 772);
    assert.deepEqual(layout.bounds, [[0, 460], [466, 1090], [1244, 1440]]);
});

test('small bars keep the panel centre, including a work-area offset', () => {
    const input = {
        panelWidth: 1920, naturalWidths: [140, 400, 196],
        viewportWidth: 400, viewportBox: 1,
    };
    assert.deepEqual(computePanelLayout(input).bounds[1], [760, 1160]);
    assert.deepEqual(computePanelLayout({...input, centerPoint: 1000}).bounds[1], [800, 1200]);
});

test('growing neighbours shrink the bar immediately while keeping their widths', () => {
    const layout = computePanelLayout({
        panelWidth: 1440, naturalWidths: [700, 900, 196],
        viewportWidth: 900, viewportBox: 1,
    });
    assert.equal(layout.availableWidth, 532);
    assert.deepEqual(layout.bounds, [[0, 700], [706, 1238], [1244, 1440]]);
});

test('items in the same box reserve space for themselves', () => {
    const layout = computePanelLayout({
        panelWidth: 1440, naturalWidths: [140, 800, 196],
        viewportWidth: 600, viewportBox: 1,
    });
    assert.equal(layout.availableWidth, 892);
    assert.equal(layout.bounds[1][1] - layout.bounds[1][0], 800);
});

test('zero free space stays zero and has no minimum-width fallback', () => {
    const layout = computePanelLayout({
        panelWidth: 668, naturalWidths: [460, 500, 196],
        viewportWidth: 500, viewportBox: 1,
    });
    assert.equal(layout.availableWidth, 0);
    assert.equal(layout.bounds[1][1] - layout.bounds[1][0], 0);
});

test('left and right placement and RTL keep the panel groups apart', () => {
    for (const viewportBox of [0, 1, 2]) {
        for (const rtl of [false, true]) {
            const widths = [300, 300, 300];
            widths[viewportBox] = 1100;
            const layout = computePanelLayout({
                panelWidth: 1440, naturalWidths: widths,
                viewportWidth: 1000, viewportBox, rtl,
            });
            const physical = rtl ? [...layout.bounds].reverse() : layout.bounds;
            assert.equal(physical[0][0], 0);
            assert.equal(physical[2][1], 1440);
            assert.ok(physical[0][1] + 6 <= physical[1][0]);
            assert.ok(physical[1][1] + 6 <= physical[2][0]);
            for (let i = 0; i < 3; i++) {
                if (i !== viewportBox)
                    assert.equal(layout.bounds[i][1] - layout.bounds[i][0], widths[i]);
            }
        }
    }
});

test('hidden and empty panel boxes do not consume width or extra gaps', () => {
    const layout = computePanelLayout({
        panelWidth: 1440, naturalWidths: [0, 500, 196],
        viewportWidth: 500, viewportBox: 1,
    });
    assert.equal(layout.availableWidth, 1238);
});

test('repeated width updates converge without feeding the bar width into its budget', () => {
    for (const viewportBox of [0, 1, 2]) {
        let viewportWidth = 500;
        for (let update = 0; update < 5; update++) {
            const widths = [250, 250, 250];
            widths[viewportBox] += viewportWidth;
            const layout = computePanelLayout({
                panelWidth: 1920, naturalWidths: widths, viewportWidth, viewportBox,
            });
            assert.equal(layout.availableWidth, 1158);
            viewportWidth = layout.availableWidth;
        }
    }
});
