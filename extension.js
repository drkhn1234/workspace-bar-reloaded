import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import Gio from "gi://Gio";

import WorkspaceBar from "./workspaceBar.js";
import { installWorkspaceRetention } from "./workspaceRetention.js";
import {MAGNIFICATION_ADVANCED, MAGNIFICATION_KEYS, readMagnificationOptions, migrateMagnificationSettings, SIZE_PRESETS} from './magnificationSettings.js';

const ACCENT_COLORS = {
    blue:   '#3584e4',
    teal:   '#2190a4',
    green:  '#3a944a',
    yellow: '#c88800',
    orange: '#ed5b00',
    red:    '#e62d42',
    pink:   '#d56199',
    purple: '#9141ac',
    slate:  '#6f8396',
};

function _buildCSS(p, accent, showBg, mag) {
    const iconsBg = showBg ? 'rgba(255, 255, 255, 0.20)' : 'transparent';
    const iconsBgDark = showBg ? 'rgba(0, 0, 0, 0.12)' : 'transparent';
    return `
.wsb-ws-btn-wrapper {
    margin-right: ${p.btnSpacing}px;
    padding: ${p.vertSpacing}px 0px ${p.vertSpacing}px 0px;
}

.wsb-ws-btn-wrapper:last-child,
.wsb-ws-btn-wrapper.wsb-last-child {
    margin-right: 0px;
}

.wsb-ws-num-wrapper {
    background-color: rgba(255, 255, 255, 0.04);
    border-radius: ${p.roundness}px 0px 0px ${p.roundness}px;
    border-top-width: ${p.borderWidth}px;
    border-right-width: 0px;
    border-bottom-width: ${p.borderWidth}px;
    border-left-width: ${p.borderWidth}px;
    border-style: solid;
    border-color: rgba(255, 255, 255, 0.15);
    padding: 0 ${p.numSpacing}px 0px ${p.numSpacing}px;
}

.wsb-ws-num-wrapper-active {
    border-color: ${accent};
}

.wsb-ws-num-label-elem {
    font-size: ${p.fontSize}px;
}

.wsb-icons-wrapper {
    background-color: ${iconsBg};
    border-style: solid;
    border-color: rgba(255, 255, 255, 0.15);
    padding: 0 ${p.wrapperSpacing}px 0px ${p.wrapperSpacing}px;
    min-width: ${Math.floor(p.iconSize / 2)}px;
    border-radius: 0px ${p.roundness}px ${p.roundness}px 0px;
    border-top-width: ${p.borderWidth}px;
    border-right-width: ${p.borderWidth}px;
    border-bottom-width: ${p.borderWidth}px;
    border-left-width: 0px;
}

.wsb-icons-wrapper-active {
    border-color: ${accent};
}

.wsb-single-icon-wrapper {
    margin-right: ${p.iconSpacing}px;
}

/* Window-count badge on a combined app icon (and on its drag actor). */
.wsb-count-badge {
    background-color: ${accent};
    color: white;
    font-size: ${Math.max(8, Math.round(p.iconSize * 0.45))}px;
    font-weight: bold;
    border-radius: 99px;
    min-width: ${Math.max(8, Math.round(p.iconSize * 0.45))}px;
    padding: 0px 2px;
    text-align: center;
}

/* Dropdown listing the windows behind a combined icon. It hangs below the
   panel in uiGroup, outside the adaptive-chrome cascade, so it carries its
   own fixed dark chrome (readable over any wallpaper, like shell menus). */
.wsb-window-popup {
    background-color: rgba(24, 24, 24, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 6px;
    spacing: 2px;
    min-width: 140px;
}

.wsb-window-popup-item {
    border-radius: 8px;
    padding: 5px 8px;
    spacing: ${p.wrapperSpacing + 3}px;
}

.wsb-window-popup-item:hover {
    background-color: rgba(255, 255, 255, 0.12);
}

.wsb-window-popup-title {
    color: rgba(255, 255, 255, 0.9);
    font-size: ${Math.max(11, p.fontSize - 2)}px;
    max-width: 260px;
}

.wsb-icons-wrapper .wsb-single-icon-wrapper:last-child {
    margin-right: 0px;
}

.wsb-ws-btn-drag-hover .wsb-icons-wrapper {
    background-color: rgba(255, 255, 255, 0.15) !important;
    border-color: rgba(255, 255, 255, 0.5) !important;
}

.wsb-ws-btn-drag-hover .wsb-ws-num-wrapper {
    background-color: rgba(255, 255, 255, 0.08) !important;
    border-color: rgba(255, 255, 255, 0.5) !important;
}

.wsb-insertion-indicator {
    background-color: ${accent};
    border-radius: 2px;
    min-width: 3px;
}

.wsb-overflow-arrow {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.55);
    padding: 0 2px;
}

/* The rim wraps both pill segments; its transparent border reserves the 1px
   so the legibility-shadows variants can color it without any reflow. */
.wsb-pill-rim {
    border: 1px solid transparent;
    border-radius: ${p.roundness + 1}px;
}

/* The chrome above assumes the stock panel: light text over a dark background.
   The bar watches the foreground color it inherits from the panel and sets at
   most one variant class below when that assumption breaks (light shell themes
   and transparency extensions today, GNOME's transparent panel in the future). */

.wsb-chrome-dark .wsb-ws-num-wrapper {
    background-color: rgba(0, 0, 0, 0.06);
    border-color: rgba(0, 0, 0, 0.25);
}

.wsb-chrome-dark .wsb-icons-wrapper {
    background-color: ${iconsBgDark};
    border-color: rgba(0, 0, 0, 0.25);
}

.wsb-chrome-dark .wsb-overflow-arrow {
    color: rgba(0, 0, 0, 0.65);
}

.wsb-chrome-dark .wsb-ws-btn-drag-hover .wsb-icons-wrapper {
    background-color: rgba(0, 0, 0, 0.10) !important;
    border-color: rgba(0, 0, 0, 0.50) !important;
}

.wsb-chrome-dark .wsb-ws-btn-drag-hover .wsb-ws-num-wrapper {
    background-color: rgba(0, 0, 0, 0.06) !important;
    border-color: rgba(0, 0, 0, 0.50) !important;
}

/* Legibility shadows (opt-in): crisp shadows behind numbers, arrows and
   icons, plus a thin shaded rim colored on the .wsb-pill-rim wrapper, just
   OUTSIDE each pill's own border, which stays untouched. No box-shadow
   anywhere: on these small translucent pills St muddies the whole interior
   with either flavor (outer is not clipped out of the box like in web CSS,
   inset renders just as dirty).
   Shadow polarity follows the panel foreground like everything else: dark
   drop shadows under light text, a light halo under dark text. */
.wsb-shadows-dark .wsb-ws-num-label-elem,
.wsb-shadows-dark .wsb-overflow-arrow {
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.8);
}

.wsb-shadows-dark StIcon {
    icon-shadow: 0 1px 1px rgba(0, 0, 0, 0.8);
}

.wsb-shadows-dark .wsb-pill-rim {
    border-color: rgba(0, 0, 0, 0.45);
}

.wsb-shadows-light .wsb-ws-num-label-elem,
.wsb-shadows-light .wsb-overflow-arrow {
    text-shadow: 0 1px 1px rgba(255, 255, 255, 0.8);
}

.wsb-shadows-light StIcon {
    icon-shadow: 0 1px 1px rgba(255, 255, 255, 0.8);
}

.wsb-shadows-light .wsb-pill-rim {
    border-color: rgba(255, 255, 255, 0.55);
}

/* The two-class variant rules above outrank the one-class -active rules, so
   the accent border of the active workspace has to be restored explicitly. */
.wsb-chrome-dark .wsb-ws-num-wrapper-active,
.wsb-chrome-dark .wsb-icons-wrapper-active {
    border-color: ${accent};
}

/* Workspace selection must update both pill segments in the same frame.
   Magnification already fades their parent actor; CSS interpolation here
   would leave the previous workspace's app border highlighted after a switch. */
.wsb-ws-num-wrapper,
.wsb-icons-wrapper,
.wsb-pill-rim {
    transition-duration: 0ms;
}

.wsb-active-workspace-highlight {
    border: ${p.borderWidth}px solid ${accent};
    border-radius: ${p.roundness}px;
    transition-duration: 0ms;
}

.wsb-magnified-icon StIcon {
    icon-shadow: 0 ${mag.iconShadowOffset}px ${mag.iconShadowBlur}px rgba(0, 0, 0, ${mag.iconShadowOpacity});
}

.wsb-magnified-number {
    text-shadow: 0 ${mag.numberShadowOffset}px ${mag.numberShadowBlur}px rgba(0, 0, 0, ${mag.numberShadowOpacity});
}

.wsb-active-ordinal-ring {
    border: ${mag.circleWidth}px solid ${accent};
    border-radius: 999px;
}
`;
}

export default class WorkspaceBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._workspaceRetention = installWorkspaceRetention(this._settings);
        migrateMagnificationSettings(this._settings, this.getPreset());
        this._magnificationOptions = null;
        this._ifaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._generateAndApplyCSS();
        this._workspaceBar = new WorkspaceBar(this);

        // Hide native workspace indicator (Activities button with dots)
        Main.panel.statusArea['activities']?.hide();

        this._settingsIds = [];
        this._settingsIds.push(this._settings.connect('changed::size-mode', () => {
            this._magnificationOptions = null;
            this._generateAndApplyCSS();
            this._workspaceBar.onSizeModeChanged();
        }));
        this._settingsIds.push(this._settings.connect('changed::position', () => {
            this._workspaceBar.onPositionChanged();
        }));
        this._settingsIds.push(this._settings.connect('changed::position-index', () => {
            this._workspaceBar.onPositionChanged();
        }));
        this._settingsIds.push(this._settings.connect('changed::show-icons-background', () => {
            this._generateAndApplyCSS();
        }));
        this._settingsIds.push(this._settings.connect('changed::legibility-shadows', () => {
            this._workspaceBar.onLegibilityShadowsChanged();
        }));
        this._settingsIds.push(this._settings.connect('changed::combine-icons', () => {
            this._workspaceBar.onCombineIconsChanged();
        }));
        for (const key of MAGNIFICATION_KEYS) {
            const option = MAGNIFICATION_ADVANCED.find(item => item.key === key);
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
                this._magnificationOptions = null;
                if (option?.css) this._generateAndApplyCSS();
                this._workspaceBar.onMagnificationSettingsChanged(option?.rebuild ?? false);
            }));
        }
        for (let key of ['focus-scale-effect', 'focus-scale-reduction',
                        'dim-inactive-icons', 'desaturate-inactive-icons']) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
                this._workspaceBar.onIconEffectsChanged();
            }));
        }

        // GNOME 47 introduced org.gnome.desktop.interface accent-color. On 45 and 46
        // the key does not exist, so there is nothing to follow.
        this._ifaceAccentId = null;
        if (this._hasAccentColorKey()) {
            this._ifaceAccentId = this._ifaceSettings.connect('changed::accent-color', () => {
                this._generateAndApplyCSS();
            });
        }
    }

    disable() {
        this._workspaceRetention?.clear();
        this._workspaceRetention = null;
        Main.wm._workspaceTracker?._queueCheckWorkspaces();

        for (let id of this._settingsIds) this._settings.disconnect(id);
        this._settingsIds = null;

        if (this._ifaceAccentId) this._ifaceSettings.disconnect(this._ifaceAccentId);
        this._ifaceAccentId = null;
        this._ifaceSettings = null;

        this._workspaceBar.destroy();
        this._workspaceBar = null;
        this._settings = null;

        // Restore native workspace indicator
        Main.panel.statusArea['activities']?.show();
    }

    getPreset() {
        let mode = this._settings.get_string('size-mode');
        return SIZE_PRESETS[mode] || SIZE_PRESETS.medium;
    }

    getMagnificationSpacing() {
        return this._settings.get_int('magnification-spacing');
    }

    getMagnificationOptions() {
        this._magnificationOptions ??= readMagnificationOptions(this._settings, this.getPreset());
        return this._magnificationOptions;
    }

    getShowActiveWorkspaceRing() {
        return this._settings.get_boolean('show-active-workspace-ring');
    }

    getPosition() {
        return this._settings.get_string('position') || 'left';
    }

    getPositionIndex() {
        return this._settings.get_int('position-index');
    }

    getShowIconsBackground() {
        return this._settings.get_boolean('show-icons-background');
    }

    getLegibilityShadows() {
        return this._settings.get_boolean('legibility-shadows');
    }

    getEnableAnimations() {
        return this._settings.get_boolean('enable-animations');
    }

    getFocusScaleEffect() {
        return this._settings.get_boolean('focus-scale-effect');
    }

    getFocusScaleReduction() {
        return this._settings.get_int('focus-scale-reduction');
    }

    getDimInactiveIcons() {
        return this._settings.get_boolean('dim-inactive-icons');
    }

    getDesaturateInactiveIcons() {
        return this._settings.get_boolean('desaturate-inactive-icons');
    }

    getMiddleClickClose() {
        return this._settings.get_boolean('middle-click-close');
    }

    getCombineIcons() {
        return this._settings.get_boolean('combine-icons');
    }

    _hasAccentColorKey() {
        return this._ifaceSettings.settings_schema.has_key('accent-color');
    }

    _getAccentColor() {
        // Reading a key the schema does not have throws, which on GNOME 45 and 46
        // took the whole extension down at enable() (the accent-color key only
        // exists from GNOME 47 on). Those versions have no user-chosen accent, so
        // fall back to the GNOME default blue.
        if (!this._hasAccentColorKey()) return ACCENT_COLORS.blue;
        let name = this._ifaceSettings.get_string('accent-color');
        return ACCENT_COLORS[name] || ACCENT_COLORS.blue;
    }

    _generateAndApplyCSS() {
        let p = this.getPreset();
        let css = _buildCSS(p, this._getAccentColor(), this.getShowIconsBackground(), this.getMagnificationOptions());
        let file = this.dir.get_child('stylesheet.css');
        file.replace_contents(new TextEncoder().encode(css), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        Main.loadTheme();
    }
}
