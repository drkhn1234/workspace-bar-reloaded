// Workspace movement and switching through continuing input, including rebuilds.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
const delay=ms=>new Promise(resolve=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{resolve();return GLib.SOURCE_REMOVE;}));

export async function checkHorizontalGestures(bar, window) {
    if(GLib.getenv('GSETTINGS_BACKEND')!=='memory')throw new Error('Requires isolated memory settings');
    const results=[], manager=global.workspace_manager, settings=bar._ext.getSettings();
    const mutter=new Gio.Settings({schema_id:'org.gnome.mutter'}), wm=new Gio.Settings({schema_id:'org.gnome.desktop.wm.preferences'});
    const keys=['gesture-horizontal-switch-workspaces','gesture-app-horizontal-scroll','gesture-workspace-horizontal-scroll',
        'gesture-horizontal-natural-scroll','gesture-horizontal-natural-switching','gesture-horizontal-natural-movement'];
    const saved=keys.map(key=>[key,settings.get_value(key)]);
    const original={settings:bar._gestureSettings,execute:bar._executeGestureAction,workspace:window.get_workspace(),
        active:manager.get_active_workspace(),dynamic:mutter.get_value('dynamic-workspaces'),count:wm.get_value('num-workspaces')};
    const check=(name,value)=>{if(!value)throw new Error(name);results.push(name);};
    const icon=()=>bar._container.get_children().flatMap(button=>button._wsbIconsWrapper?.get_children()??[]).find(source=>source.windowObj===window);
    const eventFor=source=>{
        const [x,y]=source.get_transformed_position(),[width,height]=source.get_transformed_size();
        return dx=>({get_coords:()=>[x+width/2,y+height/2],get_source:()=>source,
            get_scroll_direction:()=>Clutter.ScrollDirection.SMOOTH,get_scroll_delta:()=>[dx,0],
            get_scroll_source:()=>Clutter.ScrollSource.FINGER,get_scroll_flags:()=>0});
    };
    try{
        settings.set_boolean('gesture-horizontal-natural-scroll',false);
        mutter.set_boolean('dynamic-workspaces',false);wm.set_int('num-workspaces',5);await delay(300);
        bar._gestureSettings=settings;bar._executeGestureAction=Object.getPrototypeOf(bar)._executeGestureAction;
        original.workspace.activate(global.get_current_time());await delay(100);
        settings.set_boolean('gesture-horizontal-switch-workspaces',true);
        let event=eventFor(icon());bar._endScrollCapture();
        const start=manager.get_active_workspace_index();bar._onScrollEvent(event(1));await delay(80);
        check('shared horizontal switch advances one workspace immediately',manager.get_active_workspace_index()===start+1);
        bar._onScrollEvent(event(8));await delay(80);
        check('continued horizontal distance advances further workspaces',manager.get_active_workspace_index()===start+3);
        bar._onScrollEvent(event(40));await delay(80);
        check('large momentum stops at the last workspace',manager.get_active_workspace_index()===manager.get_n_workspaces()-1);
        bar._onScrollEvent(event(0));
        check('horizontal gesture end releases its capture',bar._scrollCaptureId===null);
        settings.set_boolean('gesture-horizontal-switch-workspaces',false);settings.set_string('gesture-app-horizontal-scroll','move-windows');
        original.workspace.activate(global.get_current_time());await delay(100);
        event=eventFor(icon());bar._onScrollEvent(event(1));await delay(120);
        check('horizontal movement moves the original app one workspace',window.get_workspace().index()===original.workspace.index()+1);
        check('a movement rebuild retains the original target and capture',bar._scrollCaptureId!==null&&bar._scrollGesture.target.windows.includes(window));
        bar._onScrollEvent(event(8));await delay(120);
        check('continued movement follows the original app across more workspaces',window.get_workspace().index()===original.workspace.index()+3);
        check('moving windows continuously does not switch the active workspace',manager.get_active_workspace()===original.workspace);
        const limit=bar._scrollGesture.workspaceCount;wm.set_int('num-workspaces',6);await delay(80);
        bar._onScrollEvent(event(40));await delay(120);
        check('one swipe does not chase newly created spare workspaces',window.get_workspace().index()===limit-1);
        bar._onScrollEvent(event(0));window.change_workspace(original.workspace);await delay(150);
        settings.set_string('gesture-workspace-horizontal-scroll','reorder-workspace');
        const source=bar._container.get_children().find(button=>button.wsIndex===original.workspace.index())._wsbNumWrapper;
        event=eventFor(source);const index=original.workspace.index();bar._onScrollEvent(event(1));await delay(120);
        bar._onScrollEvent(event(8));await delay(120);
        check('workspace reordering continues through rebuilds',original.workspace.index()===index+3);
        check('reordering keeps windows on their original workspace object',window.get_workspace()===original.workspace);
        bar._onScrollEvent(event(0));manager.reorder_workspace(original.workspace,index);await delay(100);
        settings.set_boolean('gesture-horizontal-natural-scroll',true);
        settings.set_boolean('gesture-horizontal-natural-switching',true);
        settings.set_boolean('gesture-horizontal-switch-workspaces',true);
        original.workspace.activate(global.get_current_time());await delay(80);
        event=eventFor(icon());bar._onScrollEvent(event(-1));bar._onScrollEvent(event(-8));await delay(100);
        check('natural switching reverses physical direction and preserves swipe momentum',manager.get_active_workspace_index()===original.workspace.index()+3);
        bar._onScrollEvent(event(0));settings.set_boolean('gesture-horizontal-natural-switching',false);
        original.workspace.activate(global.get_current_time());await delay(80);
        event=eventFor(icon());bar._onScrollEvent(event(1));await delay(80);
        check('switching can keep physical direction while natural movement stays selected',manager.get_active_workspace_index()===original.workspace.index()+1);
        bar._onScrollEvent(event(0));settings.set_boolean('gesture-horizontal-switch-workspaces',false);
        settings.set_boolean('gesture-horizontal-natural-movement',true);
        event=eventFor(icon());bar._onScrollEvent(event(-1));bar._onScrollEvent(event(-8));await delay(120);
        check('natural window movement reverses direction and continues on the original window',window.get_workspace().index()===original.workspace.index()+3);
        bar._onScrollEvent(event(0));settings.set_boolean('gesture-horizontal-natural-movement',false);
        event=eventFor(icon());bar._onScrollEvent(event(-1));await delay(100);
        check('movement can independently retain physical swipe direction',window.get_workspace().index()===original.workspace.index()+2);
        bar._onScrollEvent(event(0));
        window.change_workspace(original.workspace);await delay(100);
        settings.set_boolean('gesture-horizontal-natural-movement',true);
        const number=bar._container.get_children().find(button=>button.wsIndex===original.workspace.index())._wsbNumWrapper;
        event=eventFor(number);bar._onScrollEvent(event(-1));bar._onScrollEvent(event(-8));await delay(120);
        check('natural workspace reordering reverses direction and preserves momentum',original.workspace.index()===index+3);
        bar._onScrollEvent(event(0));manager.reorder_workspace(original.workspace,index);await delay(100);
        original.workspace.activate(global.get_current_time());
        settings.set_boolean('gesture-horizontal-switch-workspaces',true);settings.set_boolean('gesture-horizontal-natural-switching',true);
        const wheel={...eventFor(icon())(1),get_scroll_direction:()=>Clutter.ScrollDirection.RIGHT,get_scroll_source:()=>Clutter.ScrollSource.WHEEL};
        bar._onScrollEvent(wheel);await delay(80);
        check('natural horizontal swiping leaves mouse-wheel navigation unchanged',manager.get_active_workspace_index()===original.workspace.index()+1);
        return results;
    }finally{
        bar._endScrollCapture();window.change_workspace(original.workspace);original.active.activate(global.get_current_time());
        for(const[key,value]of saved)settings.set_value(key,value);
        mutter.set_value('dynamic-workspaces',original.dynamic);wm.set_value('num-workspaces',original.count);
        bar._gestureSettings=original.settings;bar._executeGestureAction=original.execute;await delay(250);
    }
}
