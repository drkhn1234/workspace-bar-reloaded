// Run with GSETTINGS_BACKEND=memory gjs -m tests/gesture-migration-check.mjs.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {migrateGestureSettings} from '../gestures.js';
if(GLib.getenv('GSETTINGS_BACKEND')!=='memory')throw new Error('Requires memory settings');
const root=Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const schema='org.gnome.shell.extensions.workspace-bar';
const directory=GLib.dir_make_tmp('workspace-bar-gesture-migration-XXXXXX');
let xml=new TextDecoder().decode(GLib.file_get_contents(`${root}/schemas/${schema}.gschema.xml`)[1]);
xml=xml.replace(/(<key type="s" name="gesture-(?:app|workspace)-horizontal-scroll">[\s\S]*?<choices>)/g,'$1<choice value="switch-workspace"/><choice value="scroll-bar"/>');
xml=xml.replace(/(<key type="s" name="gesture-(?:app|workspace)-(?:left|middle|right)-click">[\s\S]*?<choices>)/g,'$1<choice value="move-next"/><choice value="reorder-next"/>');
GLib.file_set_contents(`${directory}/${schema}.gschema.xml`,xml);
const [, ,stderr,status]=GLib.spawn_sync(null,['glib-compile-schemas','--strict',directory],null,GLib.SpawnFlags.SEARCH_PATH,null);
if(status)throw new Error(new TextDecoder().decode(stderr));
const source=path=>Gio.SettingsSchemaSource.new_from_directory(path,Gio.SettingsSchemaSource.get_default(),false);
const legacy=new Gio.Settings({settings_schema:source(directory).lookup(schema,false)});
const settings=new Gio.Settings({settings_schema:source(`${root}/schemas`).lookup(schema,false)});
let count=0;const check=(name,value)=>{if(!value)throw new Error(name);print(name);count++;};
const reset=()=>{for(const key of settings.settings_schema.list_keys())if(key.startsWith('gesture-'))settings.reset(key);};
try{
 reset(); legacy.set_boolean('gesture-settings-migrated',true);
 legacy.set_string('gesture-app-horizontal-scroll','scroll-bar');legacy.set_string('gesture-workspace-horizontal-scroll','switch-workspace');
 legacy.set_string('gesture-app-left-click','move-next');legacy.set_string('gesture-workspace-right-click','reorder-next');
 migrateGestureSettings(settings);
 check('actual GSettings migrates legacy horizontal modes to the shared switch',settings.get_boolean('gesture-horizontal-switch-workspaces'));
 check('removed click directions use their valid defaults',settings.get_string('gesture-app-left-click')==='activate'&&settings.get_string('gesture-workspace-right-click')==='menu');
 check('removed horizontal modes use valid per-target defaults',settings.get_string('gesture-app-horizontal-scroll')==='move-windows'&&settings.get_string('gesture-workspace-horizontal-scroll')==='move-windows');
 reset();legacy.set_boolean('gesture-settings-migrated',true);
 legacy.set_string('gesture-workspace-horizontal-scroll','reorder-workspace');
 migrateGestureSettings(settings);
 check('configured movement and reordering keep the override disabled',!settings.get_boolean('gesture-horizontal-switch-workspaces')&&settings.get_string('gesture-workspace-horizontal-scroll')==='reorder-workspace');
 check('an old unconfigured switching target is safely disabled beside a custom action',settings.get_string('gesture-app-horizontal-scroll')==='none');
 settings.set_boolean('gesture-horizontal-switch-workspaces',true);migrateGestureSettings(settings);
 check('migration does not overwrite later edits',settings.get_boolean('gesture-horizontal-switch-workspaces'));
 reset();legacy.set_boolean('gesture-settings-migrated',true);legacy.set_int('gesture-settings-version',2);
 legacy.set_string('gesture-app-middle-click','overview');legacy.set_string('gesture-app-scroll-down','overview');
 legacy.set_string('gesture-workspace-middle-click','overview');migrateGestureSettings(settings);
 check('removed app Overview actions migrate to no action rather than Close',settings.get_string('gesture-app-middle-click')==='none'&&settings.get_string('gesture-app-scroll-down')==='none');
 check('workspace Overview actions are preserved during migration',settings.get_string('gesture-workspace-middle-click')==='overview'&&settings.get_int('gesture-settings-version')===3);
 print(`${count} gesture migration checks passed`);
}finally{
 reset();GLib.unlink(`${directory}/${schema}.gschema.xml`);GLib.unlink(`${directory}/gschemas.compiled`);GLib.rmdir(directory);
}
