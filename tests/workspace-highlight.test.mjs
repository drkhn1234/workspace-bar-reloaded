import assert from 'node:assert/strict';
import test from 'node:test';
import {workspaceHighlightBounds} from '../workspaceHighlightModel.js';

const boxes = [{index: 0, x: 10, y: 3, width: 50, height: 28},
    {index: 1, x: 70, y: 3, width: 100, height: 28},
    {index: 2, x: 180, y: 3, width: 30, height: 28}];
test('the outline interpolates both edges between unequal workspace cells', () => {
    assert.deepEqual(workspaceHighlightBounds(boxes, 0.5), {x: 40, y: 3, width: 75, height: 28});
    assert.deepEqual(workspaceHighlightBounds(boxes, 1.5), {x: 125, y: 3, width: 65, height: 28});
    assert.deepEqual(workspaceHighlightBounds(boxes, 1), {x: 70, y: 3, width: 100, height: 28});
});
test('hidden cells, reversed layout and overscroll do not displace the outline beyond visible cells', () => {
    const hidden = [boxes[0], boxes[2]];
    assert.deepEqual(workspaceHighlightBounds(hidden, 1), {x: 95, y: 3, width: 40, height: 28});
    assert.equal(workspaceHighlightBounds(boxes, -2).x, 10);
    assert.equal(workspaceHighlightBounds(boxes, 9).x, 180);
    const rtl = boxes.map(box => ({...box, x: 300 - box.x - box.width}));
    assert.equal(workspaceHighlightBounds(rtl, 0.5).x, 185);
    assert.equal(workspaceHighlightBounds([], 0), null);
});
