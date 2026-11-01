// Real pointer drags in a headless GNOME Shell with disposable fixture windows.
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {resolve(); return GLib.SOURCE_REMOVE;}));

export async function checkMagnifiedEdgeDrag(bar, window) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw new Error('Requires isolated memory settings');
    const results = [], settings = bar._ext.getSettings(), extension = bar._ext;
    const original = {options: extension.getMagnificationOptions, execute: bar._executeGestureAction,
        panelY: Main.layoutManager.panelBox.y, active: global.workspace_manager.get_active_workspace(), combine: settings.get_value('combine-icons'), workspace: window.get_workspace()};
    const pointer = global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const check = (name, condition) => {if (!condition) throw new Error(name); results.push(name);};
    const move = async (x,y) => {
        pointer.notify_relative_motion(GLib.get_monotonic_time(), x-global.get_pointer()[0],0); await delay(35);
        pointer.notify_relative_motion(GLib.get_monotonic_time(),0,y-global.get_pointer()[1]); await delay(60);
    };
    const findIcon = () => bar._container.get_children().flatMap(button => button._wsbIconsWrapper?.get_children() ?? [])
        .find(source => source.windowObj && bar._getGroupWindows(source).includes(window));
    const controls = [];
    const freeze = magnifier => {
        controls.push({magnifier, pointer:magnifier._checkPointer, menu:magnifier._hasOpenMenu});
        magnifier._checkPointer=()=>{}; magnifier._hasOpenMenu=()=>true;
    };
    let held = false;
    try {
        extension.getMagnificationOptions = () => ({...original.options.call(extension), enabled:true, lift:48, duration:0, dragDelay:100});
        const clickActions = []; bar._executeGestureAction = (target, action) => clickActions.push({target,action});
        for (const combined of [false,true]) for (const bottom of [false,true]) {
            settings.set_boolean('combine-icons',combined); await delay(250);
            const monitor=Main.layoutManager.primaryMonitor, panel=Main.layoutManager.panelBox;
            panel.set_y(bottom ? monitor.y+monitor.height-panel.height : monitor.y); await delay(80);
            const magnifier=bar._magnifier, source=findIcon(), windows=bar._getGroupWindows(source);
            check('drag fixture has the expected group size',windows.length===(combined ? 2 : 1));
            magnifier._setActive(false,true); magnifier._clearEntries();
            freeze(magnifier);
            const [sx]=source.get_transformed_position(),[sw]=source.get_transformed_size(); magnifier._lastPointerX=sx+sw/2;
            magnifier._setActive(true,true); magnifier._draw(); await delay(80);
            const entry=magnifier._entries.get(source),[x]=entry.proxy.get_transformed_position(),[width]=entry.proxy.get_transformed_size();
            const y=bottom ? monitor.y+monitor.height-1 : monitor.y;
            await move(x+width/2,y);
            const picked=global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE,...global.get_pointer().slice(0,2));
            check('screen edge belongs to the magnified item input target',picked===entry.panelTarget);
            let began=false; entry.panelTarget._draggable.connect('drag-begin',()=>began=true);
            pointer.notify_button(GLib.get_monotonic_time(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.PRESSED); held=true; await delay(140);
            await move(x+width/2,y+(bottom ? -18 : 18));
            check(`${bottom ? 'bottom' : 'top'} edge starts ${combined ? 'group' : 'window'} drag`,began&&magnifier._dragging);
            check('edge drag captures the displayed windows',entry.panelTarget._delegate.wsbGroupWindows?.length===windows.length
                && windows.every(win=>entry.panelTarget._delegate.wsbGroupWindows.includes(win)));
            check('drag restores the normal bar drop targets',!magnifier._active&&magnifier._amount===0);
            const destination=global.workspace_manager.get_workspace_by_index(original.workspace.index()+1);
            const target=bar._container.get_children().find(button=>button.wsIndex===destination.index());
            const [tx]=target.get_transformed_position(),[tw]=target.get_transformed_size();
            await move(tx+tw/2,y); await delay(80);
            pointer.notify_button(GLib.get_monotonic_time(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.RELEASED); held=false; await delay(350);
            check(`${bottom ? 'bottom' : 'top'} edge drop moves ${combined ? 'both windows' : 'the displayed window'}`,windows.every(win=>win.get_workspace()===destination));
            check('a drag never executes its click action',clickActions.length===0);
            for(const win of windows)win.change_workspace(original.workspace);
            await delay(250);
        }
        const magnifier=bar._magnifier, source=findIcon(), windows=bar._getGroupWindows(source);
        magnifier._setActive(false,true); magnifier._clearEntries(); freeze(magnifier);
        const [sx]=source.get_transformed_position(),[sw]=source.get_transformed_size(); magnifier._lastPointerX=sx+sw/2;
        magnifier._setActive(true,true); magnifier._draw(); await delay(80);
        const entry=magnifier._entries.get(source),[x]=entry.proxy.get_transformed_position(),[width]=entry.proxy.get_transformed_size();
        const monitor=Main.layoutManager.primaryMonitor, y=monitor.y+monitor.height-1;
        await move(x+width/2,y);
        pointer.notify_button(GLib.get_monotonic_time(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.PRESSED); held=true; await delay(140);
        await move(x+width/2,monitor.y+monitor.height/2);
        check('edge drag can leave the panel before cancellation',magnifier._dragging);
        pointer.notify_button(GLib.get_monotonic_time(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.RELEASED); held=false; await delay(450);
        check('cancelled edge drag leaves all windows on their source workspace',windows.every(win=>win.get_workspace()===original.workspace));
        check('cancelled edge drag clears drag state and hover',!magnifier._dragging&&!bar._gapDragMonitor
            && !bar._container.get_children().some(button=>button.has_style_class_name('wsb-ws-btn-drag-hover')));
        check('cancelling a drag never executes a click action',clickActions.length===0);
        return results;
    } finally {
        if(held)pointer.notify_button(GLib.get_monotonic_time(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.RELEASED);
        for(const saved of controls){saved.magnifier._checkPointer=saved.pointer; saved.magnifier._hasOpenMenu=saved.menu;}
        original.active.activate(global.get_current_time());
        Main.layoutManager.panelBox.set_y(original.panelY);
        settings.set_value('combine-icons',original.combine);
        extension.getMagnificationOptions=original.options; bar._executeGestureAction=original.execute;
        bar._magnifier?.suspend(); bar._magnifier?.settingsChanged(true);
        await delay(250);
    }
}
