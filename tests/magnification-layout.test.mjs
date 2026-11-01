import assert from 'node:assert/strict';
import test from 'node:test';
import {centerGlyph, computeMagnificationLayout, containsPoint, opticalGlyphCenter} from '../magnificationLayout.js';

const icons = [100, 132, 164, 196, 228, 260, 292]
    .map(x => ({x, y: 3, width: 26, height: 26}));
const input = {icons, pointerX: 209, progress: 1, maxSize: 65, left: 60, right: 430, appSpacing: 6};

test('the beginning of the hover animation matches the original icon positions', () => {
    const layout = computeMagnificationLayout({...input, progress: 0});
    for (let i = 0; i < icons.length; i++) {
        assert.equal(layout[i].x, icons[i].x);
        assert.equal(layout[i].y, icons[i].y);
        assert.equal(layout[i].width, icons[i].width);
    }
});

test('the hovered icon reaches full size and neighbouring icons taper smoothly', () => {
    const layout = computeMagnificationLayout(input);
    assert.equal(layout[3].width, 65);
    assert.ok(layout[2].width > layout[1].width);
    assert.ok(layout[1].width > layout[0].width);
    assert.equal(layout[0].width, 26);
    assert.equal(layout[2].width, layout[4].width);
    for (let i = 1; i < layout.length; i++)
        assert.ok(layout[i].x >= layout[i - 1].x + layout[i - 1].width);
});

test('icons grow inward past a top panel instead of stopping at its height', () => {
    const icon = computeMagnificationLayout(input)[3];
    assert.equal(icon.y, 3);
    assert.ok(icon.y + icon.height > 32);
});

test('icons grow upward past a bottom panel while keeping their bottom edge', () => {
    const icon = computeMagnificationLayout({...input, bottom: true})[3];
    assert.equal(icon.y + icon.height, 29);
    assert.ok(icon.y < 0);
});

test('a full panel keeps the hovered icon inside the free horizontal space', () => {
    for (const pointerX of [113, 209, 305]) {
        const layout = computeMagnificationLayout({...input, pointerX, left: 100, right: 318});
        const hovered = layout.reduce((a, b) => a.width >= b.width ? a : b);
        assert.ok(hovered.x >= 100);
        assert.ok(hovered.x + hovered.width <= 318);
    }
});

test('intermediate frames grow monotonically and do not change the icon order', () => {
    let width = 0;
    for (const progress of [0, 0.1, 0.3, 0.6, 1]) {
        const layout = computeMagnificationLayout({...input, progress});
        assert.ok(layout[3].width >= width);
        assert.deepEqual(layout.map(icon => icon.index), [0, 1, 2, 3, 4, 5, 6]);
        width = layout[3].width;
    }
});

test('the magnifier works at monitor offsets and with an initially unordered list', () => {
    const shifted = icons.map(icon => ({...icon, x: icon.x + 864, y: icon.y + 1048}));
    const layout = computeMagnificationLayout({...input, icons: shifted.reverse(),
        pointerX: 1073, left: 924, right: 1294});
    assert.equal(layout[3].width, 65);
    assert.equal(layout[3].y, 1051);
    assert.equal(layout[0].index, 0);
});

test('hit testing covers both the workspace number and app portions of the bar', () => {
    const number = {x: 100, y: 0, width: 36, height: 32};
    const appArea = {x: 136, y: 0, width: 100, height: 32};
    assert.equal(containsPoint(number, 118, 16), true);
    assert.equal(containsPoint(appArea, 118, 16), false);
    assert.equal(containsPoint(number, 136, 16), false);
    assert.equal(containsPoint(appArea, 136, 16), true);
    assert.equal(containsPoint(number, 118, 40), false);
});

test('workspace numbers magnify alongside app icons without overlapping them', () => {
    const items = [
        {x: 100, y: 1, width: 33, height: 30},
        {x: 139, y: 3, width: 26, height: 26},
        {x: 171, y: 3, width: 26, height: 26},
        {x: 213, y: 1, width: 33, height: 30},
    ];
    for (const pointerX of [116.5, 152, 229.5]) {
        const layout = computeMagnificationLayout({...input, icons: items, pointerX,
            bottom: true, left: 50, right: 430});
        const hovered = items.findIndex(icon => pointerX >= icon.x && pointerX <= icon.x + icon.width);
        assert.equal(layout[hovered].width, 65);
        assert.ok(layout[hovered].height > 32);
        for (let i = 1; i < layout.length; i++)
            assert.ok(layout[i].x >= layout[i - 1].x + layout[i - 1].width);
    }
});

test('empty bars and bars with no free space have no magnified layout', () => {
    assert.deepEqual(computeMagnificationLayout({...input, icons: []}), []);
    assert.deepEqual(computeMagnificationLayout({...input, left: 100, right: 100}), []);
});

test('app-to-app spacing keeps the normal preset regardless of pointer or maximum gap setting', () => {
    for (const spacing of [0, 2, 6, 14, 64]) {
        for (const pointerX of [113, 193, 305]) {
            const layout = computeMagnificationLayout({...input, pointerX, spacing});
            const gaps = layout.slice(1).map((item, i) => item.x - layout[i].x - layout[i].width);
            assert.ok(gaps.every(gap => Math.abs(gap - 6) < 0.001));
        }
    }
});

test('spacing blends from the normal bar instead of jumping on entry', () => {
    const options = {...input, icons: workspaceItems, pointerX: 152, spacing: 20};
    const initial = computeMagnificationLayout({...options, progress: 0});
    for (let i = 0; i < workspaceItems.length; i++) assert.equal(initial[i].x, workspaceItems[i].x);
    const halfway = computeMagnificationLayout({...options, progress: 0.5});
    const full = computeMagnificationLayout({...options, progress: 1});
    for (let i = 1; i < halfway.length; i++) {
        const finalGap = full[i].x - full[i - 1].x - full[i - 1].width;
        const normalGap = workspaceItems[i].x - workspaceItems[i - 1].x - workspaceItems[i - 1].width;
        assert.ok(Math.abs(halfway[i].x - halfway[i - 1].x
            - halfway[i - 1].width - (normalGap + finalGap) / 2) < 0.001);
    }
});

test('moving between neighbours does not jump when the nearest item changes', () => {
    const mixed = icons.map((icon, index) => ({...icon,
        width: index % 2 === 0 ? 33 : 26, height: index % 2 === 0 ? 30 : 26}));
    for (const items of [icons, mixed]) {
        for (const spacing of [0, 6, 20, 64]) {
            for (const bounds of [{left: 60, right: 430}, {left: 100, right: 318}]) {
                let previous;
                for (let x = 100; x <= 320; x += 0.125) {
                    const layout = computeMagnificationLayout({...input,
                        icons: items, pointerX: x, spacing, ...bounds});
                    if (previous) {
                        for (let i = 0; i < layout.length; i++)
                            assert.ok(Math.abs(layout[i].x - previous[i].x) < 1,
                                `item ${i} jumped at pointer ${x}, spacing ${spacing}`);
                    }
                    previous = layout;
                }
            }
        }
    }
});

test('switching between fitting and overflowing layouts remains continuous', () => {
    let previous;
    for (let width = 190; width <= 390; width += 0.125) {
        const layout = computeMagnificationLayout({...input, spacing: 6,
            right: input.left + width});
        if (previous) for (let i = 0; i < layout.length; i++)
            assert.ok(Math.abs(layout[i].x - previous[i].x) < 0.5);
        previous = layout;
    }
});

test('the circle and the visible glyph share a centre despite font bearings', () => {
    for (const ink of [
        {x: 3, y: 8, width: 18, height: 37},
        {x: 1, y: 9, width: 24, height: 36},
        {x: -2, y: 7, width: 45, height: 38},
    ]) {
        const position = centerGlyph(ink, 65, 59);
        assert.equal(position.x + ink.x + ink.width / 2, 32.5);
        assert.equal(position.y + ink.y + ink.height / 2, 29.5);
    }
});

test('glyph centring converts HiDPI font metrics to actor coordinates', () => {
    const ink = {x: 2, y: 9, width: 23, height: 36};
    const expected = centerGlyph(ink, 65, 59);
    for (const scale of [1, 1.5, 2, 3]) {
        const scaled = Object.fromEntries(Object.entries(ink).map(([key, value]) => [key, value * scale]));
        assert.deepEqual(centerGlyph(scaled, 65, 59, scale), expected);
    }
});

test('symmetric glyphs need no optical correction', () => {
    const ink = {x: 3, y: 8, width: 24, height: 36};
    assert.deepEqual(opticalGlyphCenter(ink, () => true), {x: 15, y: 26});
    assert.deepEqual(opticalGlyphCenter(ink, () => false), {x: 15, y: 26});
});

test('asymmetric glyphs shift the ring horizontally while keeping vertical ink bounds centred', () => {
    const ink = {x: 0, y: 0, width: 20, height: 40};
    const center = opticalGlyphCenter(ink, (x, y) => x > 14 || y < 5);
    assert.ok(center.x > 10);
    assert.ok(center.x <= 15);
    assert.equal(center.y, 20);
});

test('a narrow digit with a heavy stem gets enough horizontal optical correction', () => {
    const ink = {x: 0, y: 0, width: 12, height: 40};
    // A long right-hand stem and a small shoulder, like a sans-serif 1.
    const center = opticalGlyphCenter(ink, (x, y) => x > 7 || (y < 6 && x > 1));
    assert.ok(center.x > 8);
    assert.ok(center.x <= 9);
    assert.equal(center.y, 20);
});

test('optical centring scales with the font metrics on HiDPI monitors', () => {
    const ink = {x: 2, y: 8, width: 24, height: 36};
    const contains = (x, y) => x > 17 || y > 32;
    const center = opticalGlyphCenter(ink, contains);
    for (const scale of [1.5, 2, 3]) {
        const scaled = Object.fromEntries(Object.entries(ink).map(([key, value]) => [key, value * scale]));
        const actual = opticalGlyphCenter(scaled, (x, y) => contains(x / scale, y / scale));
        assert.ok(Math.abs(actual.x / scale - center.x) < 0.001);
        assert.ok(Math.abs(actual.y / scale - center.y) < 0.001);
    }
});

test('app icons retain the dock curve and stay anchored at the panel edge', () => {
    for (const bottom of [false, true]) {
        const layout = computeMagnificationLayout({...input, bottom});
        const centers = layout.map(item => item.y + item.height / 2);
        assert.ok(Math.abs(centers[3] - centers[0]) > 15);
        for (let i = 0; i < layout.length; i++) {
            if (bottom)
                assert.equal(layout[i].y + layout[i].height, icons[i].y + icons[i].height);
            else
                assert.equal(layout[i].y, icons[i].y);
        }
    }
});

const workspaceItems = [
    {x: 100, y: 1, width: 33, height: 30, workspace: 0, isWorkspaceNumber: true},
    {x: 139, y: 3, width: 26, height: 26, workspace: 0},
    {x: 171, y: 3, width: 26, height: 26, workspace: 0},
    {x: 213, y: 1, width: 33, height: 30, workspace: 1, isWorkspaceNumber: true},
    {x: 252, y: 3, width: 26, height: 26, workspace: 1},
    {x: 294, y: 1, width: 33, height: 30, workspace: 2, isWorkspaceNumber: true},
];

test('workspace numbers and separators consume one normal app step in the magnification curve', () => {
    const plain = [100, 132, 164].map(x => ({x, y: 3, width: 26, height: 26}));
    const decorated = [
        {x: 60, y: 1, width: 33, height: 30, workspace: 0, isWorkspaceNumber: true},
        {...plain[0], workspace: 0},
        {x: 170, y: 1, width: 80, height: 30, workspace: 1, isWorkspaceNumber: true},
        {...plain[1], x: 260, workspace: 1},
        {x: 390, y: 1, width: 180, height: 30, workspace: 2, isWorkspaceNumber: true},
        {...plain[2], x: 600, workspace: 2},
    ];
    for (let segment = 0; segment < 2; segment++) {
        for (let fraction = 0; fraction <= 1; fraction += 0.05) {
            const a = decorated[segment * 2 + 1], b = decorated[segment * 2 + 3];
            const actual = computeMagnificationLayout({...input, icons: decorated, right: 2000,
                pointerX: a.x + 13 + (b.x - a.x) * fraction});
            const expected = computeMagnificationLayout({...input, icons: plain, right: 2000,
                pointerX: plain[segment].x + 13 + 32 * fraction});
            for (let i = 0; i < plain.length; i++) {
                assert.ok(Math.abs(actual[i * 2 + 1].width - expected[i].width) < 0.001);
                assert.ok(Math.abs(actual[i * 2 + 1].height - expected[i].height) < 0.001);
            }
        }
    }
});

test('adjacent single-app workspaces keep both icons near maximum size over their intervening number', () => {
    for (const numberWidth of [10, 50, 500]) {
        for (const separator of [8, 64, 300]) {
            const items = [
                {x: 100, y: 3, width: 26, height: 26, workspace: 0},
                {x: 132, y: 1, width: numberWidth, height: 30, workspace: 1, isWorkspaceNumber: true},
                {x: 132 + numberWidth + separator, y: 3, width: 26, height: 26, workspace: 1},
            ];
            const pointerX = (items[0].x + items[2].x) / 2 + 13;
            const layout = computeMagnificationLayout({...input, icons: items, pointerX, right: 2000});
            assert.ok(layout[0].width > input.maxSize * 0.9);
            assert.ok(Math.abs(layout[0].width - layout[2].width) < 0.001);
            assert.ok(Math.abs(layout[1].width / items[1].width - layout[2].width / items[2].width) < 0.001);
        }
    }
});

test('the app-only curve uses the normal app spacing of each size preset', () => {
    for (const [width, appSpacing] of [[16, 3], [20, 5], [26, 6]]) {
        const plain = [100, 100 + width + appSpacing].map(x => ({x, y: 3, width, height: width}));
        const decorated = [
            {...plain[0], workspace: 0},
            {x: 150, y: 1, width: 100, height: 30, workspace: 1, isWorkspaceNumber: true},
            {...plain[1], x: 350, workspace: 1},
        ];
        const actual = computeMagnificationLayout({...input, icons: decorated, appSpacing,
            pointerX: (100 + 350 + width) / 2, right: 1000});
        const expected = computeMagnificationLayout({...input, icons: plain, appSpacing,
            pointerX: (plain[0].x + plain[1].x + width) / 2, right: 1000});
        assert.ok(Math.abs(actual[0].width - expected[0].width) < 0.001);
        assert.ok(Math.abs(actual[2].width - expected[1].width) < 0.001);
    }
});

test('bars containing only empty workspaces still magnify their draggable numbers', () => {
    const items = [100, 151, 202].map((x, workspace) => ({x, y: 1, width: 33, height: 30,
        workspace, isWorkspaceNumber: true}));
    const layout = computeMagnificationLayout({...input, icons: items, pointerX: 167.5});
    assert.equal(layout[1].width, 65);
    assert.equal(layout[0].width, items[0].width);
    assert.equal(layout[2].width, items[2].width);
});

test('hovering an app never independently magnifies nearby empty workspace numbers', () => {
    const items = [
        {x: 100, y: 1, width: 33, height: 30, workspace: 0, isWorkspaceNumber: true},
        {x: 139, y: 3, width: 26, height: 26, workspace: 0},
        {x: 171, y: 1, width: 33, height: 30, workspace: 1, isWorkspaceNumber: true},
        {x: 222, y: 1, width: 33, height: 30, workspace: 2, isWorkspaceNumber: true},
    ];
    const layout = computeMagnificationLayout({...input, icons: items, pointerX: 152});
    assert.equal(layout[1].width, 65);
    assert.equal(layout[2].width, items[2].width);
    assert.equal(layout[3].width, items[3].width);
    assert.ok(Math.abs(layout[0].width / items[0].width - layout[1].width / items[1].width) < 0.001);
});

test('the actual hover gate controls empty numbers without affecting app-following numbers', () => {
    const items = workspaceItems.map(icon => icon.isWorkspaceNumber ? {...icon, independentHover: 0} : icon);
    const normal = computeMagnificationLayout({...input, icons: items, pointerX: 310.5});
    assert.equal(normal[5].width, items[5].width);
    const hovered = computeMagnificationLayout({...input, icons: items.map((icon, i) =>
        i === 5 ? {...icon, independentHover: 1} : icon), pointerX: 310.5});
    assert.equal(hovered[5].width, 65);
    for (const i of [0, 1, 2, 3, 4]) assert.equal(hovered[i].width, normal[i].width);
    const appHover = computeMagnificationLayout({...input, icons: items, pointerX: 152});
    assert.ok(appHover[0].width > items[0].width);
    assert.ok(Math.abs(appHover[0].width / items[0].width - appHover[1].width / items[1].width) < 0.001);
});

test('independent hover animation is monotonic and numbers stay normal between empty workspaces', () => {
    const items = [100, 151].map((x, workspace) => ({x, y: 1, width: 33, height: 30,
        workspace, isWorkspaceNumber: true}));
    const between = computeMagnificationLayout({...input, icons: items, pointerX: 142});
    assert.equal(between[0].width, 33);
    assert.equal(between[1].width, 33);
    let previous = 0;
    for (const independentHover of [0, 0.1, 0.5, 0.9, 1]) {
        const layout = computeMagnificationLayout({...input, icons: items.map((icon, index) =>
            ({...icon, independentHover: index === 0 ? independentHover : 0})), pointerX: 116.5});
        assert.ok(layout[0].width >= previous);
        assert.equal(layout[1].width, 33);
        previous = layout[0].width;
    }
});

test('compact workspace numbers remain under the pointer when approached across wide group gaps', () => {
    const items = workspaceItems.map(icon => icon.isWorkspaceNumber
        ? {...icon, contentInsets: {left: 10, right: 10}} : icon);
    const visibleCenter = icon => icon.x + (icon.leftInset + icon.width - icon.rightInset) / 2;
    for (const index of [0, 3]) {
        const initial = computeMagnificationLayout({...input, icons: items, spacing: 64,
            pointerX: items[index].x + items[index].width / 2, left: 0, right: 1500});
        const pointerX = visibleCenter(initial[index]);
        const approached = computeMagnificationLayout({...input, icons: items, spacing: 64,
            pointerX, left: 0, right: 1500});
        assert.ok(pointerX >= approached[index].x + approached[index].leftInset);
        assert.ok(pointerX <= approached[index].x + approached[index].width - approached[index].rightInset);
    }
});

test('the spacing setting changes workspace boundaries without changing number-to-own-icons or app gaps', () => {
    for (const pointerX of [116, 152, 190, 240, 310]) {
        for (const spacing of [0, 6, 20, 64]) {
            const layout = computeMagnificationLayout({...input, icons: workspaceItems,
                pointerX, spacing, right: 700});
            for (const [number, app] of [[0, 1], [3, 4]]) {
                const gap = layout[app].x - layout[number].x - layout[number].width;
                assert.ok(Math.abs(gap - 6) < 0.001);
            }
            assert.ok(Math.abs(layout[2].x - layout[1].x - layout[1].width - 6) < 0.001);
        }
    }
});

test('workspace boundaries follow the affected neighbour and return to normal outside the region', () => {
    for (const spacing of [0, 2, 20, 64]) {
        const layout = computeMagnificationLayout({...input, icons: workspaceItems,
            pointerX: 184, spacing});
        const gap = layout[3].x - layout[2].x - layout[2].width;
        assert.ok(Math.abs(gap - spacing) < 0.001);
    }
});

test('a zero spacing setting retains a small preset gutter between neighbouring workspace numbers', () => {
    const items = [
        {x: 100, y: 1, width: 33, height: 30, workspace: 0, isWorkspaceNumber: true,
            contentInsets: {left: 10, right: 10}},
        {x: 151, y: 1, width: 33, height: 30, workspace: 1, isWorkspaceNumber: true,
            contentInsets: {left: 10, right: 10}},
    ];
    const layout = computeMagnificationLayout({...input, icons: items,
        pointerX: 167.5, spacing: 0, minimumGroupSpacing: 6});
    const gap = layout[1].x + layout[1].leftInset
        - layout[0].x - layout[0].width + layout[0].rightInset;
    assert.ok(Math.abs(gap - 6) < 0.001);
});

test('outside the influence region all item sizes and local gaps match the normal bar for every spacing setting', () => {
    for (const spacing of [0, 6, 20, 64]) {
        for (const pointerX of [-1000, 1000]) {
            const layout = computeMagnificationLayout({...input, icons: workspaceItems, pointerX, spacing});
            for (let i = 0; i < layout.length; i++) {
                assert.equal(layout[i].width, workspaceItems[i].width);
                assert.equal(layout[i].height, workspaceItems[i].height);
                assert.equal(layout[i].y, workspaceItems[i].y);
                if (i === 0) continue;
                const gap = layout[i].x - layout[i - 1].x - layout[i - 1].width;
                const normalGap = workspaceItems[i].x - workspaceItems[i - 1].x - workspaceItems[i - 1].width;
                assert.ok(Math.abs(gap - normalGap) < 0.001);
            }
        }
    }
});

test('automatic ordinal spacing also works when the number follows its app icons', () => {
    const items = [
        {x: 100, y: 3, width: 26, height: 26, workspace: 0},
        {x: 132, y: 3, width: 26, height: 26, workspace: 0},
        {x: 164, y: 1, width: 33, height: 30, workspace: 0, isWorkspaceNumber: true},
    ];
    for (const pointerX of [100, 145, 230]) {
        const layout = computeMagnificationLayout({...input, icons: items, pointerX, spacing: 14});
        const appGap = layout[1].x - layout[0].x - layout[0].width;
        const numberGap = layout[2].x - layout[1].x - layout[1].width;
        assert.ok(Math.abs(appGap - 6) < 0.001);
        assert.ok(Math.abs(numberGap - 6) < 0.001);
    }
});

test('visible digit and active-circle footprints have the same compact gap to their app group', () => {
    for (const contentInsets of [{left: 10, right: 10}, {left: 3, right: 3}]) {
        const items = workspaceItems.map((icon, index) => index === 0 ? {...icon, contentInsets} : icon);
        for (const spacing of [0, 64]) {
            const layout = computeMagnificationLayout({...input, icons: items, pointerX: 152, spacing});
            const number = layout[0], app = layout[1];
            const gap = app.x - (number.x + number.width - number.rightInset);
            assert.ok(Math.abs(gap - 6) < 0.001);
            assert.ok(number.width - number.leftInset - number.rightInset < number.width);
        }
    }
});

test('automatic preset gaps separate interior workspace circles from both neighbouring app groups', () => {
    const icons = [
        {x: 100, y: 1, width: 33, height: 30, workspace: 0, isWorkspaceNumber: true},
        {x: 133, y: 3, width: 26, height: 26, workspace: 0},
        {x: 192, y: 1, width: 33, height: 30, workspace: 1, isWorkspaceNumber: true,
            contentInsets: {left: -2, right: 1}},
        {x: 225, y: 3, width: 26, height: 26, workspace: 1},
    ];
    const result = computeMagnificationLayout({...input, icons, pointerX: 238,
        compression: 1, cutoffDistance: 96, spacing: 16, minimumGroupSpacing: 6, numberGap: 6});
    const previous = result[1], number = result[2], app = result[3];
    const before = number.x + number.leftInset - previous.x - previous.width;
    const after = app.x - number.x - number.width + number.rightInset;
    assert.ok(before >= 6);
    assert.ok(Math.abs(after - 6) < 0.001);
});

test('cropping transparent ordinal padding preserves the normal visible positions outside the region', () => {
    const items = workspaceItems.map(icon => icon.isWorkspaceNumber
        ? {...icon, contentInsets: {left: 8, right: 8}} : icon);
    const layout = computeMagnificationLayout({...input, icons: items, pointerX: 1000, spacing: 64});
    for (let i = 0; i < items.length; i++) {
        assert.ok(Math.abs(layout[i].x - items[i].x) < 0.001);
        assert.equal(layout[i].width, items[i].width);
    }
});

test('compact visible footprints remain continuous and never overlap as the pointer crosses workspace boundaries', () => {
    const items = workspaceItems.map(icon => icon.isWorkspaceNumber
        ? {...icon, contentInsets: {left: 10, right: 10}} : icon);
    for (const spacing of [0, 6, 64]) {
        let previous;
        for (let pointerX = 100; pointerX <= 330; pointerX += 0.125) {
            const layout = computeMagnificationLayout({...input, icons: items, pointerX, spacing});
            for (let i = 0; i < layout.length; i++) {
                if (previous) assert.ok(Math.abs(layout[i].x - previous[i].x) < 1);
                if (i > 0) assert.ok(layout[i].x + layout[i].leftInset
                    - layout[i - 1].x - layout[i - 1].width + layout[i - 1].rightInset >= -1e-9);
            }
            previous = layout;
        }
    }
});

test('each ordinal matches its nearest app in the same workspace, preserving other icon heights', () => {
    for (const bottom of [false, true]) {
        for (let pointerX = 100; pointerX <= 330; pointerX++) {
            const layout = computeMagnificationLayout({...input, icons: workspaceItems,
                pointerX, bottom, right: 700});
            for (const [number, app] of [[0, 1], [3, 4]]) {
                assert.ok(Math.abs(layout[number].width / workspaceItems[number].width
                    - layout[app].width / workspaceItems[app].width) < 0.001);
                assert.ok(Math.abs(layout[number].y + layout[number].height / 2
                    - layout[app].y - layout[app].height / 2) < 0.001);
            }
        }
    }
    const layout = computeMagnificationLayout({...input, icons: workspaceItems,
        pointerX: 152, right: 700});
    assert.ok(layout[1].height > layout[2].height);
    assert.ok(layout[1].height > layout[4].height);
    assert.notEqual(layout[0].y + layout[0].height / 2,
        layout[3].y + layout[3].height / 2);
});

test('grouped ordinals animate from their original positions and empty ones magnify independently', () => {
    const initial = computeMagnificationLayout({...input, icons: workspaceItems, progress: 0});
    for (let i = 0; i < workspaceItems.length; i++) {
        assert.equal(initial[i].x, workspaceItems[i].x);
        assert.equal(initial[i].y, workspaceItems[i].y);
        assert.equal(initial[i].width, workspaceItems[i].width);
    }
    const layout = computeMagnificationLayout({...input, icons: workspaceItems,
        pointerX: 310.5, right: 700});
    assert.equal(layout[5].width, 65);
    assert.equal(layout[0].width, workspaceItems[0].width);
});

test('paired ordinals stay continuous as the pointer travels between apps and workspace groups', () => {
    for (const spacing of [6, 20, 64]) {
        let previous;
        for (let pointerX = 100; pointerX <= 330; pointerX += 0.125) {
            const layout = computeMagnificationLayout({...input, icons: workspaceItems,
                pointerX, bottom: true, spacing});
            if (previous) for (let i = 0; i < layout.length; i++) {
                assert.ok(Math.abs(layout[i].x - previous[i].x) < 1);
                assert.ok(Math.abs(layout[i].y - previous[i].y) < 1);
            }
            for (let i = 1; i < layout.length; i++)
                assert.ok(layout[i].x - layout[i - 1].x - layout[i - 1].width >= -1e-9);
            previous = layout;
        }
    }
});

test('an ordinal chooses the geometrically nearest app from an unordered group', () => {
    const items = [
        workspaceItems[2], workspaceItems[0], workspaceItems[1],
    ];
    const layout = computeMagnificationLayout({...input, icons: items, pointerX: 152});
    assert.ok(Math.abs(layout[1].width / items[1].width - layout[2].width / items[2].width) < 0.001);
    assert.ok(Math.abs(layout[1].y + layout[1].height / 2 - layout[2].y - layout[2].height / 2) < 0.001);
});
