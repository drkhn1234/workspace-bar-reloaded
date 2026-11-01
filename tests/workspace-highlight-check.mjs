import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {resolve(); return GLib.SOURCE_REMOVE;}));

export async function checkWorkspaceHighlight(bar) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw new Error('Requires isolated memory settings');
    const results = [], manager = global.workspace_manager, settings = bar._ext.getSettings(), highlight = bar._highlight;
    const active = manager.get_active_workspace(), opacity = bar._container.opacity;
    const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}), animations = desktop.get_value('enable-animations');
    const keys = ['smooth-workspace-highlight', 'enable-animations'], saved = keys.map(key => [key, settings.get_value(key)]);
    const check = (name, valid) => {if (!valid) throw new Error(name); results.push(name);};
    let shared;
    try {
        settings.set_boolean('smooth-workspace-highlight', false);
        const next = manager.get_workspace_by_index((active.index() + 1) % manager.get_n_workspaces());
        next.activate(global.get_current_time());
        const buttons = bar._container.get_children(), target = buttons.find(button => button.wsIndex === next.index());
        check('both halves of the active workspace highlight update together', buttons.every(button =>
            button._wsbNumWrapper.has_style_class_name('wsb-ws-num-wrapper-active') === (button === target)
            && button._wsbIconsWrapper.has_style_class_name('wsb-icons-wrapper-active') === (button === target)));
        check('workspace borders have no delayed CSS colour transitions', buttons.every(button =>
            button._wsbNumWrapper.get_theme_node().get_transition_duration() === 0
            && button._wsbIconsWrapper.get_theme_node().get_transition_duration() === 0));
        await delay(350);
        settings.set_boolean('enable-animations', true); desktop.set_boolean('enable-animations', true);
        settings.set_boolean('smooth-workspace-highlight', true); await delay(300);
        check('smooth selection replaces individual active borders with one outline', highlight.actor.visible
            && buttons.every(button => !button._wsbNumWrapper.has_style_class_name('wsb-ws-num-wrapper-active')
                && !button._wsbIconsWrapper.has_style_class_name('wsb-icons-wrapper-active')));
        shared = highlight._workspaceAdjustment.value;
        highlight._workspaceAdjustment.value = 0;
        const first = {x: highlight.actor.x, width: highlight.actor.width};
        highlight._workspaceAdjustment.value = 1;
        const second = {x: highlight.actor.x, width: highlight.actor.width};
        highlight._workspaceAdjustment.value = 0.5;
        check('the outline follows GNOME fractional workspace progress without an extra animation',
            Math.abs(highlight.actor.x - (first.x + second.x) / 2) < 0.1
            && Math.abs(highlight.actor.width - (first.width + second.width) / 2) < 0.1
            && !highlight._position.get_transition('value'));
        const [x, y] = highlight.actor.get_transformed_position(), [width, height] = highlight.actor.get_transformed_size();
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x + width / 2, y + height / 2);
        check('the sliding outline never intercepts drop targets', picked !== highlight.actor);
        bar._container.opacity = 123;
        check('the outline fades with the normal bar during magnification', highlight.actor.opacity === 123);
        bar._container.opacity = opacity;
        settings.set_boolean('enable-animations', false); highlight.activeChanged();
        check('disabling extension animations makes the outline immediate', highlight._position.value === manager.get_active_workspace_index() && !highlight._position.get_transition('value'));
        settings.set_boolean('enable-animations', true); desktop.set_boolean('enable-animations', false); await delay(30);
        highlight.activeChanged();
        check('disabled GNOME animations also make the outline immediate', !St.Settings.get().enable_animations && !highlight._position.get_transition('value'));
        return results;
    } finally {
        if (shared !== undefined) highlight._workspaceAdjustment.value = shared;
        desktop.set_value('enable-animations', animations);
        for (const [key, value] of saved) settings.set_value(key, value);
        bar._container.opacity = opacity;
        active.activate(global.get_current_time()); await delay(350);
    }
}
