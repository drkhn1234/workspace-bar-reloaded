import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {workspaceHighlightBounds} from './workspaceHighlightModel.js';

// Read GNOME's shared workspace adjustment, which is also used by its Overview
// highlight. Never write to it: doing so would move GNOME's workspace views.
export default class WorkspaceHighlight {
    constructor(bar) {
        this._bar = bar;
        this._settings = bar._ext.getSettings();
        this._signals = [];
        this.actor = new St.Widget({name: 'workspace-bar-active-highlight',
            style_class: 'wsb-active-workspace-highlight', reactive: false, visible: false});
        Shell.util_set_hidden_from_pick(this.actor, true);
        bar._clip.add_child(this.actor);
        this._opacity = bar._container.bind_property('opacity', this.actor, 'opacity', GObject.BindingFlags.SYNC_CREATE);
        const active = global.workspace_manager.get_active_workspace_index();
        this._position = new St.Adjustment({actor: this.actor, lower: 0, upper: 16384, value: active});
        this._workspaceAdjustment = Main.createWorkspacesAdjustment(this.actor);
        this._connect(this._position, 'notify::value', () => this.refresh());
        this._connect(this._workspaceAdjustment, 'notify::value', () => {
            if (!this.enabled) return;
            this._position.remove_transition('value');
            this._position.value = this._animationsEnabled
                ? this._workspaceAdjustment.value : global.workspace_manager.get_active_workspace_index();
        });
        this._connect(this._settings, 'changed', (_settings, key) => {
            if (['smooth-workspace-highlight', 'enable-animations'].includes(key)) bar._updateActiveWorkspace();
        });
        this._connect(St.Settings.get(), 'notify::enable-animations', () => this.activeChanged());
        this._connect(bar._container, 'notify::allocation', () => this.refresh());
        this._connect(bar._clip, 'notify::allocation', () => this.refresh());
        this.refresh();
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    get enabled() {return this._settings.get_boolean('smooth-workspace-highlight');}
    get _animationsEnabled() {return this._settings.get_boolean('enable-animations') && St.Settings.get().enable_animations;}

    activeChanged() {
        this._position.remove_transition('value');
        const active = global.workspace_manager.get_active_workspace_index();
        if (this.enabled && this._animationsEnabled) {
            // Also cover switches where GNOME does not run a workspace animation.
            // Shared adjustment updates take over as soon as GNOME supplies them.
            this._position.ease(active, {duration: 250, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            this._position.value = active;
        }
        this.refresh();
    }

    refresh() {
        if (!this.enabled) {this.actor.hide(); return;}
        const boxes = [];
        for (const button of this._bar._container.get_children()) {
            if (!button.visible) continue;
            const number = button._wsbNumWrapper, icons = button._wsbIconsWrapper;
            const [x, y] = number.get_transformed_position(), [ix] = icons.get_transformed_position();
            const [width] = icons.get_transformed_size(), [, height] = number.get_transformed_size();
            if (width <= 0 || height <= 0) continue;
            const [, localX, localY] = this._bar._clip.transform_stage_point(x, y);
            boxes.push({index: button.wsIndex, x: localX, y: localY, width: ix + width - x, height});
        }
        const box = workspaceHighlightBounds(boxes, this._position.value);
        this.actor.visible = !!box;
        if (box) {
            this.actor.set_position(box.x, box.y);
            this.actor.set_size(box.width, box.height);
        }
    }

    destroy() {
        for (const [object, id] of this._signals) object.disconnect(id);
        this._signals = [];
        this._position.remove_transition('value');
        this._opacity.unbind();
        this.actor.destroy();
        this._workspaceAdjustment = null;
        this._position = null;
    }
}
