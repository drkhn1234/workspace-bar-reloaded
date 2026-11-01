import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DEFAULT_CONFIGURATION} from '../defaultConfiguration.js';
import {GESTURE_INPUTS, gestureActions, gestureDefault, horizontalActions, migrateGestureSettings,
    ScrollGestureTracker, horizontalGestureAction, horizontalSwipeDirection, runWindowGesture} from '../gestures.js';

test('natural horizontal swiping independently reverses switching and movement, with mouse and vertical input unchanged', () => {
    for (const switching of [false, true]) for (const affectSwitching of [false, true]) for (const affectMovement of [false, true]) {
        const options = {touchpad: true, natural: true, switching, affectSwitching, affectMovement};
        const reverse = switching ? affectSwitching : affectMovement;
        assert.equal(horizontalSwipeDirection('left', options), reverse ? 'right' : 'left');
        assert.equal(horizontalSwipeDirection('right', options), reverse ? 'left' : 'right');
        assert.equal(horizontalSwipeDirection('left', {...options, touchpad: false}), 'left');
        assert.equal(horizontalSwipeDirection('left', {...options, natural: false}), 'left');
        assert.equal(horizontalSwipeDirection('up', options), 'up');
    }
});

test('natural horizontal direction is independent of the operating system natural-scroll setting', () => {
    for (const inverted of [false, true]) {
        const tracker = new ScrollGestureTracker();
        const physical = tracker.feed({dx: inverted ? -2 : 2, dy: 0, time: 0, touchpad: true, inverted});
        assert.equal(horizontalSwipeDirection(physical.direction, {touchpad: true, natural: true,
            switching: true, affectSwitching: true, affectMovement: false}), 'left');
    }
});

function fixture() {
    let active = 1;
    const workspaces = [0, 1, 2].map(index => ({index() {return workspaces.indexOf(this);},
        id: index, activate() {active = workspaces.indexOf(this);}}));
    const manager = {get_n_workspaces: () => workspaces.length, get_active_workspace_index: () => active,
        get_workspace_by_index: index => workspaces[index],
        reorder_workspace(workspace, index) {workspaces.splice(workspaces.indexOf(workspace), 1); workspaces.splice(index, 0, workspace);}};
    const makeWindow = (index, sticky = false) => ({workspace: workspaces[index], sticky, closed: 0,
        get_workspace() {return this.workspace;}, is_on_all_workspaces() {return this.sticky;},
        unstick() {this.sticky = false;}, change_workspace(workspace) {this.workspace = workspace;},
        can_close() {return true;}, delete() {this.closed++;}});
    return {workspaces, manager, makeWindow};
}

test('all gesture choices and defaults are accepted by the installed schema', () => {
    const schema = readFileSync(new URL('../schemas/org.gnome.shell.extensions.workspace-bar.gschema.xml', import.meta.url), 'utf8');
    for (const kind of ['app', 'workspace']) for (const [input, , value] of GESTURE_INPUTS) {
        const key = schema.match(new RegExp(`<key type="s" name="gesture-${kind}-${input}">([\\s\\S]*?)</key>`))[1];
        let choices = [...key.matchAll(/<choice value="([^"]+)"\/>/g)].map(match => match[1]);
        if (kind === 'app') choices = choices.filter(value => value !== 'overview');
        assert.deepEqual(choices, (input === 'horizontal-scroll' ? horizontalActions(kind) : gestureActions(kind, input)).map(option => option[0]));
        assert.ok(key.includes(`<default>'${gestureDefault(kind, input)}'</default>`));
    }
    assert.ok(horizontalActions('workspace').some(([value]) => value === 'reorder-workspace'));
    assert.ok(!horizontalActions('app').some(([value]) => value === 'reorder-workspace'));
});

function gestureSettings(values = {}) {
    const defaults = {'gesture-settings-migrated': false, 'gesture-settings-version': 0,
        'gesture-horizontal-switch-workspaces': DEFAULT_CONFIGURATION['gesture-horizontal-switch-workspaces'], 'middle-click-close': false};
    for (const kind of ['app','workspace']) for (const [input,,value] of GESTURE_INPUTS) defaults[`gesture-${kind}-${input}`] = gestureDefault(kind,input);
    return {values, get_boolean: key => values[key] ?? defaults[key], get_int: key => values[key] ?? defaults[key],
        get_string: key => values[key] ?? defaults[key],
        get_user_value: key => Object.hasOwn(values,key) ? {deep_unpack: () => values[key]} : null,
        set_string: (key,value) => values[key]=value, set_boolean: (key,value) => values[key]=value,
        set_int: (key,value) => values[key]=value, reset: key => delete values[key]};
}

test('fresh settings retain the selected defaults through migration', () => {
    const settings = gestureSettings();
    migrateGestureSettings(settings);
    assert.equal(settings.get_string('gesture-app-middle-click'), 'new-instance');
    assert.equal(settings.get_boolean('gesture-horizontal-switch-workspaces'), true);
    for (const kind of ['app', 'workspace']) for (const [input] of GESTURE_INPUTS)
        assert.equal(settings.get_string(`gesture-${kind}-${input}`), gestureDefault(kind, input));
    assert.ok(gestureActions('app').some(([action]) => action === 'new-instance'));
    assert.ok(gestureActions('workspace').every(([action]) => action !== 'new-instance'));
});

test('legacy middle-click preferences migrate once without overwriting a configured action', () => {
    for (const legacy of [false,true]) {
        const settings = gestureSettings({'middle-click-close':legacy});
        migrateGestureSettings(settings);
        assert.equal(settings.get_string('gesture-app-middle-click'),legacy ? 'close' : 'none');
        settings.set_string('gesture-app-middle-click','move-active'); migrateGestureSettings(settings);
        assert.equal(settings.get_string('gesture-app-middle-click'),'move-active');
        settings.set_boolean('gesture-settings-migrated',false); migrateGestureSettings(settings);
        assert.equal(settings.get_string('gesture-app-middle-click'),'move-active');
    }
});

test('legacy horizontal switching and bar scrolling migrate to the shared switch', () => {
    const settings = gestureSettings({'gesture-settings-migrated':true,
        'gesture-app-horizontal-scroll':'scroll-bar','gesture-workspace-horizontal-scroll':'switch-workspace'});
    migrateGestureSettings(settings);
    assert.equal(settings.get_boolean('gesture-horizontal-switch-workspaces'),true);
    assert.equal(settings.get_string('gesture-app-horizontal-scroll'),'move-windows');
    assert.equal(settings.get_string('gesture-workspace-horizontal-scroll'),'move-windows');
    settings.set_boolean('gesture-horizontal-switch-workspaces',false); migrateGestureSettings(settings);
    assert.equal(settings.get_boolean('gesture-horizontal-switch-workspaces'),false);
});

test('migration preserves customized horizontal actions and disables the shared override', () => {
    const settings = gestureSettings({'gesture-settings-migrated':true,'gesture-workspace-horizontal-scroll':'reorder-workspace'});
    migrateGestureSettings(settings);
    assert.equal(settings.get_boolean('gesture-horizontal-switch-workspaces'),false);
    assert.equal(settings.get_string('gesture-workspace-horizontal-scroll'),'reorder-workspace');
    assert.equal(settings.get_string('gesture-app-horizontal-scroll'),'none');
});

test('click menus and migration exclude directional actions', () => {
    const settings = gestureSettings({'gesture-settings-migrated':true,'gesture-app-left-click':'move-next',
        'gesture-workspace-right-click':'reorder-previous','gesture-app-middle-click':'move-active'});
    migrateGestureSettings(settings);
    assert.equal(settings.get_string('gesture-app-left-click'),'activate');
    assert.equal(settings.get_string('gesture-workspace-right-click'),'menu');
    assert.equal(settings.get_string('gesture-app-middle-click'),'move-active');
    for(const kind of ['app','workspace'])for(const input of ['left-click','middle-click','right-click'])
        assert.ok(gestureActions(kind,input).every(([action])=>!/(previous|next)$/.test(action)));
    assert.ok(gestureActions('workspace','scroll-up').some(([action])=>action==='reorder-next'));
    assert.ok(horizontalActions('app').every(([action])=>!['scroll-bar','switch-workspace'].includes(action)));
});

test('a vertical touchpad gesture keeps its starting target and executes only once', () => {
    const tracker = new ScrollGestureTracker(), first = {windows: ['original']}, second = {windows: ['replacement']};
    assert.equal(tracker.feed({dx: 0.1, dy: 0.4, time: 0, target: first}), null);
    assert.deepEqual(tracker.feed({dx: 0.1, dy: 0.7, time: 20, target: second}), {direction: 'down', target: first});
    for (let time = 30; time < 300; time += 30) assert.equal(tracker.feed({dx: 0, dy: 8, time, target: second}), null);
    tracker.feed({dx: 0, dy: 0, time: 300, finished: true});
    assert.deepEqual(tracker.feed({dx: -2, dy: 0.2, time: 310, target: second}), {direction: 'left', target: second});
});

test('touchpad swipes follow physical direction with either natural-scroll setting', () => {
    for (const inverted of [false, true]) for (const [dx, dy, direction] of [[0, -2, 'up'], [0, 2, 'down'], [-2, 0, 'left'], [2, 0, 'right']]) {
        const tracker = new ScrollGestureTracker(), target = {windows: ['original']}, sign = inverted ? -1 : 1;
        assert.deepEqual(tracker.feed({dx: dx * sign, dy: dy * sign, time: 0, target, touchpad: true, inverted}), {direction, target});
        assert.equal(tracker.feed({dx: dx * sign, dy: dy * sign, time: 20, target: {windows: ['replacement']}, touchpad: true, inverted}), null);
    }
});

test('touchpad direction correction does not reverse mouse-wheel input', () => {
    const tracker = new ScrollGestureTracker();
    assert.equal(tracker.feed({dx: 0, dy: -1, time: 0, discrete: true, inverted: true}).direction, 'up');
});

test('smooth scrolling without finish events recovers after inactivity; wheel detents are debounced', () => {
    const tracker = new ScrollGestureTracker();
    assert.equal(tracker.feed({dx: 2, dy: 0, time: 0}).direction, 'right');
    assert.equal(tracker.feed({dx: 0, dy: -2, time: 400}).direction, 'up');
    assert.equal(tracker.feed({dx: 0, dy: 1, time: 500, discrete: true}).direction, 'down');
    assert.equal(tracker.feed({dx: 0, dy: 1, time: 520, discrete: true}), null);
    assert.equal(tracker.feed({dx: 0, dy: -1, time: 700, discrete: true}).direction, 'up');
});

test('horizontal target modes provide movement and reordering without duplicate switching', () => {
    assert.equal(horizontalGestureAction('switch-workspace', 'left'), 'none');
    assert.equal(horizontalGestureAction('scroll-bar', 'right'), 'none');
    assert.equal(horizontalGestureAction('move-windows', 'right'), 'move-next');
    assert.equal(horizontalGestureAction('reorder-workspace', 'left'), 'reorder-previous');
    assert.equal(horizontalGestureAction('none', 'right'), 'none');
});

test('move-to-active moves a captured group without activating another workspace', () => {
    const {manager, workspaces, makeWindow} = fixture(), windows = [makeWindow(0), makeWindow(0, true)];
    runWindowGesture('move-active', {windows, workspace: workspaces[0], manager, time: 10});
    assert.ok(windows.every(window => window.workspace === workspaces[1] && !window.sticky));
    assert.equal(manager.get_active_workspace_index(), 1);
});

test('close affects only captured windows, once each, and honours windows that cannot close', () => {
    const {manager, workspaces, makeWindow} = fixture(), one = makeWindow(0), two = makeWindow(0), untouched = makeWindow(0);
    two.can_close = () => false;
    runWindowGesture('close', {windows: [one, two, one], workspace: workspaces[0], manager, time: 10});
    assert.equal(one.closed, 1); assert.equal(two.closed, 0); assert.equal(untouched.closed, 0);
});

test('window movement uses the hovered workspace while navigation uses the active workspace', () => {
    const {manager, workspaces, makeWindow} = fixture(), window = makeWindow(0);
    runWindowGesture('move-next', {windows: [window], workspace: workspaces[0], manager, time: 10});
    assert.equal(window.workspace, workspaces[1]); assert.equal(manager.get_active_workspace_index(), 1);
    runWindowGesture('switch-next', {windows: [], workspace: workspaces[0], manager, time: 10});
    assert.equal(manager.get_active_workspace_index(), 2);
});

test('workspace reorder preserves windows on their workspace object', () => {
    const {manager, workspaces, makeWindow} = fixture(), window = makeWindow(1), workspace = workspaces[1];
    runWindowGesture('reorder-previous', {windows: [window], workspace, manager, time: 10});
    assert.equal(workspaces[0], workspace); assert.equal(window.workspace, workspace);
});

test('movement and workspace switching stop at the first and last workspace', () => {
    const {manager, workspaces, makeWindow} = fixture(), window = makeWindow(0);
    runWindowGesture('move-previous', {windows: [window], workspace: workspaces[0], manager, time: 10});
    runWindowGesture('reorder-previous', {windows: [], workspace: workspaces[0], manager, time: 10});
    assert.equal(window.workspace, workspaces[0]); assert.equal(workspaces[0].id, 0);
    for (let i = 0; i < 5; i++) runWindowGesture('switch-next', {windows: [], manager, time: 10});
    assert.equal(manager.get_active_workspace_index(), 2);
});

test('targets removed during a scroll cannot close or move replacement windows', () => {
    const {manager, workspaces, makeWindow} = fixture(), closed = makeWindow(0), removed = {index: () => -1};
    closed.workspace = null;
    runWindowGesture('close', {windows: [closed], workspace: removed, manager, time: 10});
    runWindowGesture('move-active', {windows: [closed], workspace: removed, manager, time: 10});
    runWindowGesture('reorder-next', {windows: [], workspace: removed, manager, time: 10});
    assert.equal(closed.closed, 0); assert.equal(closed.workspace, null);
    assert.deepEqual(workspaces.map(workspace => workspace.id), [0, 1, 2]);
});

test('horizontal distance and inertia repeat on the original target', () => {
    const tracker=new ScrollGestureTracker(), target={windows:['original']}, replacement={windows:['replacement']};
    assert.equal(tracker.feed({dx:0.5,dy:0,time:0,target}),null);
    assert.deepEqual(tracker.feed({dx:0.5,dy:0,time:10,target:replacement}),{direction:'right',target});
    assert.equal(tracker.feed({dx:3,dy:0,time:20,target:replacement}),null);
    assert.deepEqual(tracker.feed({dx:1,dy:0,time:30,target:replacement}),{direction:'right',target});
    assert.deepEqual(tracker.feed({dx:12,dy:0,time:40,target:replacement}),{direction:'right',target,steps:3});
    assert.deepEqual(tracker.feed({dx:-4,dy:0,time:50,target:replacement}),{direction:'left',target});
});

test('coalesced motion and small momentum events produce the same number of horizontal steps', () => {
    const count=deltas=>{const tracker=new ScrollGestureTracker();let steps=0;deltas.forEach((dx,i)=>{
        const action=tracker.feed({dx,dy:0,time:i*10,target:'source'});if(action)steps+=action.steps??1;
    });return steps;};
    assert.equal(count([21]),6);
    assert.equal(count(Array(42).fill(0.5)),6);
});

test('vertical gestures stay single-action even with horizontal drift and long momentum', () => {
    const tracker=new ScrollGestureTracker();
    assert.equal(tracker.feed({dx:0,dy:2,time:0,target:'source'}).direction,'down');
    for(let i=1;i<20;i++)assert.equal(tracker.feed({dx:20,dy:20,time:i*10,target:'replacement'}),null);
});

test('Overview is offered only for workspace gestures and old app bindings become no action', () => {
    for(const [input] of GESTURE_INPUTS)if(input!=='horizontal-scroll'){
        assert.ok(!gestureActions('app',input).some(([action])=>action==='overview'));
        assert.ok(gestureActions('workspace',input).some(([action])=>action==='overview'));
    }
    const settings=gestureSettings({'gesture-settings-migrated':true,'gesture-settings-version':2,
        'gesture-app-left-click':'overview','gesture-app-middle-click':'overview','gesture-app-scroll-down':'overview',
        'gesture-workspace-middle-click':'overview','gesture-app-right-click':'close'});
    migrateGestureSettings(settings);
    assert.equal(settings.get_string('gesture-app-left-click'),'none');
    assert.equal(settings.get_string('gesture-app-middle-click'),'none');
    assert.equal(settings.get_string('gesture-app-scroll-down'),'none');
    assert.equal(settings.get_string('gesture-workspace-middle-click'),'overview');
    assert.equal(settings.get_string('gesture-app-right-click'),'close');
    assert.equal(settings.get_int('gesture-settings-version'),3);
});
