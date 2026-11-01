import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceRetentionPolicy, withPreservedWorkspaces, cancelQueuedWorkspaceCheck} from '../workspaceRetentionPolicy.js';
const scene = () => ({a: {}, b: {}, c: {}, spare: {}});
const run = (policy, list, occupied, now, duration = 30000) => policy.evaluate(list, new Set(occupied), now, duration);

test('empty gaps get a fixed grace period while trailing empties follow GNOME', () => {
    const {a, b, c, spare} = scene(), policy = new WorkspaceRetentionPolicy();
    const result = run(policy, [a, b, c, spare], [a, c], 1000);
    assert.deepEqual(result.preserved, [b]); assert.equal(result.nextExpiry, 31000);
    assert.equal(policy.emptySince.has(spare), false);
});

test('repeated native checks never extend the cooldown', () => {
    const {a, b, c} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b, c], [a, c], 1000);
    for (const now of [1500, 10000, 30999]) assert.equal(run(policy, [a, b, c], [a, c], now).nextExpiry, 31000);
    assert.deepEqual(run(policy, [a, b, c], [a, c], 31000), {preserved: [], nextExpiry: null});
});

test('expired empty workspaces cannot rearm themselves while GNOME keeps them active', () => {
    const {a, b} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b], [b], 0);
    for (const now of [30000, 60000, 100000]) assert.deepEqual(run(policy, [a, b], [b], now).preserved, []);
});

test('filling cancels a grace period and emptying again starts a new one', () => {
    const {a, b} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b], [b], 0);
    assert.deepEqual(run(policy, [a, b], [a, b], 25000), {preserved: [], nextExpiry: null});
    assert.equal(run(policy, [a, b], [b], 26000).nextExpiry, 56000);
    assert.deepEqual(run(policy, [a, b], [b], 31000).preserved, [a]);
});

test('a placement between native checks still resets the empty episode', () => {
    const {a, b} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b], [b], 0);
    policy.filled(a); // Added then removed while workspace checks were paused.
    assert.equal(run(policy, [a, b], [b], 29000).nextExpiry, 59000);
});

test('a previously expired workspace gets a new grace period only after being filled', () => {
    const {a, b} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b], [b], 0); run(policy, [a, b], [b], 40000);
    policy.filled(a);
    assert.equal(run(policy, [a, b], [b], 41000).nextExpiry, 71000);
});

test('reordering does not reset timers or transfer them to a different workspace', () => {
    const {a, b, c} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b, c], [c], 0);
    const result = run(policy, [b, a, c], [c], 20000);
    assert.deepEqual(result.preserved, [b, a]); assert.equal(result.nextExpiry, 30000);
    assert.deepEqual(run(policy, [b, a, c], [c], 30000).preserved, []);
});

test('removing another workspace preserves object identity and discards removed records', () => {
    const {a, b, c} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b, c], [c], 0);
    assert.equal(run(policy, [b, c], [c], 10000).nextExpiry, 30000);
    assert.equal(policy.emptySince.has(a), false);
});

test('empty gaps that become trailing do not get protection or restart later', () => {
    const {a, b, c} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b, c], [a, c], 0);
    assert.deepEqual(run(policy, [a, b, c], [a], 20000), {preserved: [], nextExpiry: null});
    assert.deepEqual(run(policy, [a, b, c], [a, c], 31000).preserved, []);
});

test('a trailing spare starts its grace period when it first becomes an interior gap', () => {
    const {a, b, c} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b], [a], 0);
    assert.equal(run(policy, [a, b, c], [a, c], 60000).nextExpiry, 90000);
});

test('multiple grace periods wake at the earliest remaining deadline', () => {
    const {a, b, c} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b, c], [b, c], 0);
    assert.equal(run(policy, [a, b, c], [c], 10000).nextExpiry, 30000);
    assert.equal(run(policy, [a, b, c], [c], 30000).nextExpiry, 40000);
    assert.deepEqual(run(policy, [a, b, c], [c], 40000), {preserved: [], nextExpiry: null});
});

test('changing the duration uses elapsed empty time instead of starting over', () => {
    const {a, b} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b], [b], 1000);
    assert.equal(run(policy, [a, b], [b], 10000, 60000).nextExpiry, 61000);
    assert.deepEqual(run(policy, [a, b], [b], 10000, 5000).preserved, []);
});

test('zero duration disables retention and clear forgets outstanding episodes', () => {
    const {a, b} = scene(), policy = new WorkspaceRetentionPolicy();
    run(policy, [a, b], [b], 0);
    assert.deepEqual(run(policy, [a, b], [b], 1000, 0), {preserved: [], nextExpiry: null});
    assert.equal(policy.emptySince.size, 0);
    run(policy, [a, b], [b], 2000); policy.clear(); assert.equal(policy.emptySince.size, 0);
});

test('native keep-alive IDs survive the synchronous marker and cleanup', () => {
    const a = {}, b = {_keepAliveId: 123};
    const result = withPreservedWorkspaces([a, b], () => {
        assert.equal(typeof a._keepAliveId, 'symbol'); assert.equal(b._keepAliveId, 123); return 'native-result';
    });
    assert.equal(result, 'native-result'); assert.equal(a._keepAliveId, undefined); assert.equal(b._keepAliveId, 123);
});

test('the retention marker is restored even when the native tracker throws', () => {
    const a = {_keepAliveId: 0};
    assert.throws(() => withPreservedWorkspaces([a], () => {throw new Error('native failure');}), /native failure/);
    assert.equal(a._keepAliveId, 0);
});

test('a new native keep-alive created inside the check is never overwritten', () => {
    const a = {};
    withPreservedWorkspaces([a], () => {a._keepAliveId = 321;});
    assert.equal(a._keepAliveId, 321);
});

test('queued native checks cannot bypass a newly installed policy or retain a removed one', () => {
    const pending = new Map(); let nextId = 1, oldCalls = 0, newCalls = 0;
    const tracker = {_checkWorkspacesId: 0, _checkWorkspaces: () => oldCalls++,
        _queueCheckWorkspaces() {if (!this._checkWorkspacesId) {this._checkWorkspacesId = nextId++; pending.set(this._checkWorkspacesId, this._checkWorkspaces.bind(this));}}};
    const laters = {remove: id => pending.delete(id)};
    tracker._queueCheckWorkspaces();
    tracker._checkWorkspaces = () => newCalls++;
    cancelQueuedWorkspaceCheck(tracker, laters); tracker._queueCheckWorkspaces();
    for (const check of pending.values()) check();
    assert.equal(oldCalls, 0); assert.equal(newCalls, 1);
    cancelQueuedWorkspaceCheck(tracker, laters); assert.equal(pending.size, 0);
    cancelQueuedWorkspaceCheck(tracker, laters); // clear is idempotent
});
