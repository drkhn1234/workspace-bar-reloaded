// Exercise Overview and real workspace activation in an isolated shell.
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const delay=ms=>new Promise(resolve=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{resolve();return GLib.SOURCE_REMOVE;}));
export async function checkWorkspaceOverview(bar, window){
 if(GLib.getenv('GSETTINGS_BACKEND')!=='memory')throw new Error('Requires isolated memory settings');
 const results=[],manager=global.workspace_manager,active=manager.get_active_workspace(),execute=bar._executeGestureAction;
 const check=(name,value)=>{if(!value)throw new Error(name);results.push(name);};
 const target=manager.get_workspace_by_index((active.index()+1)%manager.get_n_workspaces());
 try{
  bar._executeGestureAction=Object.getPrototypeOf(bar)._executeGestureAction;
  Main.overview.hide();await delay(350);
  bar._executeGestureAction({kind:'workspace',workspace:target},'overview');await delay(450);
  check('Overview opens on the workspace where its gesture was performed',Main.overview.visible&&manager.get_active_workspace()===target);
  bar._executeGestureAction({kind:'workspace',workspace:target},'overview');await delay(450);
  check('repeating workspace Overview closes it on that workspace',!Main.overview.visible&&manager.get_active_workspace()===target);
  bar._executeGestureAction({kind:'workspace',workspace:active},'overview');await delay(450);
  check('Overview can open on a different targeted workspace',Main.overview.visible&&manager.get_active_workspace()===active);
  bar._executeGestureAction({kind:'workspace',workspace:target},'overview');await delay(450);
  check('an Overview gesture switches to its target even when closing Overview',!Main.overview.visible&&manager.get_active_workspace()===target);
  bar._executeGestureAction({kind:'app',window,workspace:active},'overview');await delay(80);
  check('legacy app Overview actions cannot toggle or switch workspaces',!Main.overview.visible&&manager.get_active_workspace()===target);
  bar._executeGestureAction({kind:'workspace',workspace:{index:()=>-1,activate:()=>{throw new Error('removed target activated');}}},'overview');
  check('a removed workspace cannot toggle Overview',!Main.overview.visible);
  return results;
 }finally{
  Main.overview.hide();active.activate(global.get_current_time());bar._executeGestureAction=execute;await delay(450);
 }
}
